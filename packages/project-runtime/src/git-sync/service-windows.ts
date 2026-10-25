import { setTimeout as pause } from "node:timers/promises";
import { RelayError } from "@relay/contracts";
import type { GitSyncEnvironment } from "./client.types";
import { gitSyncMessages as messages } from "./git-sync.messages";
import { runServiceCommand as native } from "./service-command";
import { serviceFiles } from "./service-files";
import { probeGitSyncSupervisorLock } from "./supervisor";
import type {
  WindowsServiceSnapshot,
  WindowsStopContext,
  WindowsStopPhase,
} from "./service-windows.types";
import type {
  GitSyncServiceAction,
  NativeServiceStatus,
  ServiceConfiguration,
} from "./service.types";

const SERVICE_STOP_TIMEOUT_MS = 30_000;
const SERVICE_STOP_POLL_MS = 50;

/**
 * Читает имя текущего Windows-пользователя в UTF-8, не полагаясь на OEM-кодировку whoami.exe.
 */
export async function currentWindowsUser(environment: GitSyncEnvironment): Promise<string> {
  const script =
    "$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false); [Security.Principal.WindowsIdentity]::GetCurrent().Name";
  const identity = await native(environment, "powershell.exe", [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-EncodedCommand",
    Buffer.from(script, "utf16le").toString("base64"),
  ]);
  return identity.stdout.replace(/^\uFEFF/u, "").trim();
}

/**
 * Запрашивает Windows Task Scheduler через COM с машинным HRESULT отсутствия задачи.
 * EncodedCommand переносит Unicode/кавычки без cmd.exe и локализованного разбора schtasks.
 */
async function readWindowsSnapshot(
  configuration: ServiceConfiguration,
  environment: GitSyncEnvironment,
): Promise<WindowsServiceSnapshot> {
  const name = configuration.id.replaceAll("'", "''");
  const script = `$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false); $s=New-Object -ComObject Schedule.Service; $s.Connect(); try { $t=$s.GetFolder('\\').GetTask('${name}'); @{exists=$true; state=$t.State; enabled=$t.Enabled; description=$t.Definition.RegistrationInfo.Description; runningInstances=$t.GetInstances(0).Count} | ConvertTo-Json -Compress } catch { $failure=$_.Exception; while ($failure.InnerException) { $failure=$failure.InnerException }; if ($failure.HResult -eq -2147024894) { '{"exists":false}' } else { throw } }`;
  const result = await native(environment, "powershell.exe", [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-EncodedCommand",
    Buffer.from(script, "utf16le").toString("base64"),
  ]);
  let value: unknown;
  try {
    value = JSON.parse(result.stdout.replace(/^\uFEFF/u, ""));
  } catch {
    throw new RelayError("GIT_SYNC_SERVICE_PROTOCOL", messages.invalidResponse);
  }
  if (
    !value ||
    typeof value !== "object" ||
    !("exists" in value) ||
    typeof value.exists !== "boolean"
  ) {
    throw new RelayError("GIT_SYNC_SERVICE_PROTOCOL", messages.invalidResponse);
  }
  if (!value.exists) {
    return {
      native: {
        registered: false,
        enabled: false,
        state: "stopped",
        managerExitCode: result.exitCode,
      },
      runningInstances: 0,
    };
  }
  if (!("description" in value) || value.description !== configuration.marker) {
    throw new RelayError("GIT_SYNC_SERVICE_OWNERSHIP", messages.serviceOwnership, 4, {
      id: configuration.id,
    });
  }
  if (
    !("state" in value) ||
    typeof value.state !== "number" ||
    !("enabled" in value) ||
    typeof value.enabled !== "boolean" ||
    !("runningInstances" in value) ||
    typeof value.runningInstances !== "number" ||
    !Number.isSafeInteger(value.runningInstances) ||
    value.runningInstances < 0
  ) {
    throw new RelayError("GIT_SYNC_SERVICE_PROTOCOL", messages.invalidResponse);
  }
  let state: NativeServiceStatus["state"] = "unknown";
  if (value.state === 4) {
    state = "running";
  } else if (value.state === 1 || value.state === 3) {
    state = "stopped";
  }
  return {
    native: { registered: true, enabled: value.enabled, state, managerExitCode: result.exitCode },
    runningInstances: value.runningInstances,
  };
}

/**
 * Возвращает публичное состояние без внутреннего счётчика stop-барьера.
 */
export async function windowsState(
  configuration: ServiceConfiguration,
  environment: GitSyncEnvironment,
): Promise<NativeServiceStatus> {
  return (await readWindowsSnapshot(configuration, environment)).native;
}

/**
 * Определяет завершение задачи в manager; это ещё не подтверждение освобождения её файловых locks.
 */
function taskStopped(snapshot: WindowsServiceSnapshot): boolean {
  return (
    !snapshot.native.registered ||
    (snapshot.native.state === "stopped" && snapshot.runningInstances === 0)
  );
}

/**
 * Проверяет отмену и общий монотонный deadline до native-действия; остаток — положительное целое ms.
 */
function stopEnvironment(
  context: WindowsStopContext,
  current: WindowsServiceSnapshot,
  phase: WindowsStopPhase,
): GitSyncEnvironment {
  const { environment, deadline, timeoutMs, config } = context;
  if (environment.signal?.aborted) {
    throw new RelayError(
      "GIT_SYNC_CANCELLED",
      messages.processCancelled,
      environment.signal.reason === "SIGTERM" ? 143 : 130,
    );
  }
  const remaining = deadline - performance.now();
  if (remaining <= 0) {
    throw new RelayError(
      "GIT_SYNC_SERVICE_FAILED",
      phase === "wait-supervisor-lock" ? messages.supervisorLockBusy : messages.nativeFailed,
      4,
      {
        id: config.id,
        phase,
        timeoutMs,
        native: current.native,
        runningInstances: current.runningInstances,
      },
    );
  }
  return { ...environment, timeoutMs: Math.ceil(remaining) };
}

/**
 * Гасит автоматические активации собственной task до End и mutex-барьера.
 * Change обновляет definition, но Disabled запрещает запуск RegistrationTrigger.
 * Успешный exit утилиты подтверждается readonly Enabled; отказ не откатывается повторной активацией.
 */
async function quiesceWindowsTask(
  context: WindowsStopContext,
  initial: WindowsServiceSnapshot,
): Promise<WindowsServiceSnapshot> {
  if (!initial.native.registered || initial.native.enabled === false) {
    return initial;
  }
  await native(stopEnvironment(context, initial, "quiesce"), "schtasks.exe", [
    "/Change",
    "/TN",
    context.config.id,
    "/Disable",
  ]);
  const current = await readWindowsSnapshot(
    context.config,
    stopEnvironment(context, initial, "quiesce"),
  );
  if (current.native.registered && current.native.enabled !== false) {
    throw new RelayError("GIT_SYNC_SERVICE_FAILED", messages.nativeFailed, 4, {
      id: context.config.id,
      phase: "quiesce",
      native: current.native,
    });
  }
  return current;
}

/**
 * Гасит триггеры и останавливает старую регистрацию до замены definition, ждёт manager и SQLite mutex S.
 * Change/End выполняются не более одного раза; затем только COM и технический захват/release.
 * Ready/Disabled, отсутствие instances и endpoint сами по себе не разрешают Create или успешный disable.
 * Чужой живой владелец не останавливается и сохраняет busy до deadline без замены definition.
 * Монотонный бюджет не зависит от коррекции часов ОС; native timeout округляется вверх до ms.
 */
async function stopWindowsTask(
  config: ServiceConfiguration,
  environment: GitSyncEnvironment,
  initial: WindowsServiceSnapshot,
): Promise<WindowsServiceSnapshot> {
  const timeoutMs = environment.timeoutMs ?? SERVICE_STOP_TIMEOUT_MS;
  const deadline = performance.now() + timeoutMs;
  const context: WindowsStopContext = { config, environment, deadline, timeoutMs };
  let current = await quiesceWindowsTask(context, initial);
  if (!taskStopped(current)) {
    await native(stopEnvironment(context, current, "wait-stopped"), "schtasks.exe", [
      "/End",
      "/TN",
      config.id,
    ]);
  }
  for (;;) {
    const remainingEnvironment = stopEnvironment(
      context,
      current,
      taskStopped(current) ? "wait-supervisor-lock" : "wait-stopped",
    );
    if (!taskStopped(current)) {
      current = await readWindowsSnapshot(config, remainingEnvironment);
    }
    if (taskStopped(current)) {
      if (environment.signal?.aborted || performance.now() >= deadline) {
        continue;
      }
      const lock = (environment.supervisorLockProbe ?? probeGitSyncSupervisorLock)(config.home);
      if (lock === "free") {
        if (environment.signal?.aborted || performance.now() >= deadline) {
          continue;
        }
        return current;
      }
    }
    const pauseRemaining = deadline - performance.now();
    // Полученный во время COM abort сохраняет прежний CANCELLED и при истёкшем deadline.
    if (pauseRemaining <= 0 && !environment.signal?.aborted) {
      continue;
    }
    try {
      await pause(
        Math.min(SERVICE_STOP_POLL_MS, Math.max(1, Math.ceil(pauseRemaining))),
        undefined,
        {
          signal: environment.signal,
        },
      );
    } catch (cause) {
      if (!environment.signal?.aborted) {
        throw cause;
      }
      throw new RelayError(
        "GIT_SYNC_CANCELLED",
        messages.processCancelled,
        environment.signal.reason === "SIGTERM" ? 143 : 130,
      );
    }
  }
}

/**
 * Регистрирует одну task текущего пользователя; RegistrationTrigger запускает прямой Exec после Create.
 * При disable триггеры уже погашены, а manager и SQLite owner подтверждены stop-барьером.
 */
export async function windowsService(
  action: GitSyncServiceAction,
  config: ServiceConfiguration,
  environment: GitSyncEnvironment,
): Promise<NativeServiceStatus> {
  const current = await readWindowsSnapshot(config, environment);
  if (action === "status") {
    return current.native;
  }
  const stopped = await stopWindowsTask(config, environment, current);
  if (action === "disable") {
    if (stopped.native.registered) {
      await native(environment, "schtasks.exe", ["/Delete", "/TN", config.id, "/F"]);
    }
    (environment.serviceFiles ?? serviceFiles).remove(config.path);
    return { registered: false, enabled: false, state: "stopped", managerExitCode: 0 };
  }
  await native(environment, "schtasks.exe", [
    "/Create",
    "/TN",
    config.id,
    "/XML",
    config.path,
    "/F",
  ]);
  return windowsState(config, environment);
}
