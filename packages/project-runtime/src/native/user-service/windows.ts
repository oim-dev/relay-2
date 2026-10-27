import { setTimeout as pause } from "node:timers/promises";
import { win32 } from "node:path";
import { createWindowsServiceConfiguration } from "../service-configuration/windows";
import { runUserServiceCommand as native } from "./command";
import { createUserServiceFiles } from "./files";
import type { WindowsServiceSnapshot, WindowsStopContext, WindowsStopPhase } from "./windows.types";
import type {
  UserServiceAction,
  NativeServiceStatus,
  ServiceConfiguration,
  UserServiceAdapter,
  UserServiceContext,
} from "./service.types";

const SERVICE_STOP_POLL_MS = 50;

/**
 * Читает имя текущего Windows-пользователя в UTF-8, не полагаясь на OEM-кодировку whoami.exe.
 */
async function currentWindowsUser(environment: UserServiceContext): Promise<string> {
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
  environment: UserServiceContext,
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
  } catch (cause) {
    throw environment.failure("protocol", 1, undefined, cause);
  }
  if (
    !value ||
    typeof value !== "object" ||
    !("exists" in value) ||
    typeof value.exists !== "boolean"
  ) {
    throw environment.failure("protocol", 1);
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
    throw environment.failure("ownership", 4, {
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
    throw environment.failure("protocol", 1);
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
async function windowsState(
  configuration: ServiceConfiguration,
  environment: UserServiceContext,
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
): UserServiceContext {
  const { environment, deadline, timeoutMs, config } = context;
  if (environment.signal?.aborted) {
    throw environment.failure("cancelled", environment.signal.reason === "SIGTERM" ? 143 : 130);
  }
  const remaining = deadline - performance.now();
  if (remaining <= 0) {
    throw environment.failure(phase === "wait-supervisor-lock" ? "lock" : "command", 4, {
      id: config.id,
      phase,
      timeoutMs,
      native: current.native,
      runningInstances: current.runningInstances,
    });
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
    throw context.environment.failure("command", 4, {
      id: context.config.id,
      phase: "quiesce",
      native: current.native,
    });
  }
  return current;
}

/**
 * Гасит триггеры и останавливает старую регистрацию до замены definition, ждёт manager и lease владельца.
 * Change/End выполняются не более одного раза; затем только COM и технический захват/release.
 * Ready/Disabled, отсутствие instances и endpoint сами по себе не разрешают Create или успешный disable.
 * Чужой живой владелец не останавливается и сохраняет busy до deadline без замены definition.
 * Монотонный бюджет не зависит от коррекции часов ОС; native timeout округляется вверх до ms.
 */
async function stopWindowsTask(
  config: ServiceConfiguration,
  environment: UserServiceContext,
  initial: WindowsServiceSnapshot,
): Promise<WindowsServiceSnapshot> {
  const timeoutMs = environment.timeoutMs;
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
      const lock = environment.probeLease();
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
      throw environment.failure("cancelled", environment.signal.reason === "SIGTERM" ? 143 : 130);
    }
  }
}

/**
 * Регистрирует одну task текущего пользователя; RegistrationTrigger запускает прямой Exec после Create.
 * При disable триггеры уже погашены, а manager и lease приложения подтверждены stop-барьером.
 * Для enable COM ownership проверяется до публикации XML и ещё раз перед stop-фазой.
 */
async function controlWindowsService(
  action: UserServiceAction,
  config: ServiceConfiguration,
  environment: UserServiceContext,
): Promise<NativeServiceStatus> {
  if (action === "enable") {
    await windowsState(config, environment);
    environment.files.write(config.path, config.content);
  }
  const current = await readWindowsSnapshot(config, environment);
  if (action === "status") {
    return current.native;
  }
  const stopped = await stopWindowsTask(config, environment, current);
  if (action === "disable") {
    if (stopped.native.registered) {
      await native(environment, "schtasks.exe", ["/Delete", "/TN", config.id, "/F"]);
    }
    environment.files.remove(config.path);
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

/**
 * Server использует тот же quiesce/stop/lease-барьер и предварительный COM ownership при disable.
 * Нативные exit code сохраняются; readiness Server не выводится из результата task.
 */
async function registerWindowsService(
  action: "enable" | "disable",
  config: ServiceConfiguration,
  context: UserServiceContext,
): Promise<void> {
  if (action === "disable") {
    await windowsState(config, context);
  }
  await controlWindowsService(action, config, context);
}

/**
 * Task Scheduler текущего пользователя: UTF-16LE с BOM, Windows paths и обязательный lease-порт.
 */
export const windowsUserService: UserServiceAdapter = {
  platform: "win32",
  files: createUserServiceFiles("utf16le", "\uFEFF"),
  /**
   * Разрешает home по Windows даже на хосте теста с POSIX-синтаксисом.
   */
  resolveHome: (cwd, home, userHome): string =>
    win32.resolve(cwd, home ?? win32.resolve(userHome, ".relay")),
  /**
   * Task Scheduler делит namespace между пользователями; регистр DOMAIN\user не меняет identity.
   */
  scopeIdentity: (home, userName): string => `${userName?.toLowerCase()}\0${home}`,
  /**
   * Читает native WindowsIdentity только при отсутствии явного имени.
   */
  resolveUserName: async (context, userName): Promise<string> =>
    userName ?? currentWindowsUser(context),
  configure: createWindowsServiceConfiguration,
  control: controlWindowsService,
  register: registerWindowsService,
};
