import { rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { setTimeout as pause } from "node:timers/promises";
import { randomUUID } from "node:crypto";
import { RelayError, type ServerInstanceList, type ServerInstanceStatus } from "@relay/contracts";
import { acquireLocalLock } from "@relay/storage";
import type { RuntimeOptions } from "../configuration/runtime-options.types";
import { hasCode } from "../configuration/files";
import { runNativeProcess } from "../git-sync/process";
import { replaceLocalFile } from "../local-files/replace";
import { nativeBrowserCommand } from "../native/browser/select";
import { discoverServerBinary } from "./discovery";
import {
  checkServerCancellation,
  listServerInstances,
  probeServerInstance,
  serverControl,
} from "./probe";
import {
  createServerLaunch,
  probeServerLease,
  readServerEndpoint,
  readServerLaunch,
  serverDirectory,
  serverHome,
} from "./registry";
import { serverMessages as messages } from "./server.messages";
import { controlServerService } from "./service";
import type { ServerClient, ServerEnvironment, ServerLaunch } from "./server.types";

/**
 * Адресует launch выбранного UUID без выбора проекта; после удаления executable stop остаётся доступен.
 */
function selectedLaunch(options: RuntimeOptions, instanceId: string): ServerLaunch {
  try {
    return readServerLaunch(join(serverDirectory(serverHome(options), instanceId), "launch.json"));
  } catch (cause) {
    if (hasCode(cause, "ENOENT")) {
      throw new RelayError("SERVER_NOT_FOUND", messages.notFound, 3, { instanceId });
    }
    throw cause;
  }
}

/**
 * Ожидает health либо освобождение lease с монотонным бюджетом; повторяются только наблюдения.
 */
async function waitServer(
  launch: ServerLaunch,
  environment: ServerEnvironment,
  ready: boolean,
): Promise<ServerInstanceStatus> {
  const deadline = performance.now() + (environment.readinessTimeoutMs ?? 10_000);
  for (;;) {
    checkServerCancellation(environment);
    const status = await probeServerInstance(launch, {
      ...environment,
      timeoutMs: Math.max(1, Math.min(2000, Math.ceil(deadline - performance.now()))),
    });
    if (ready ? status.state === "ready" : probeServerLease(launch) === "free") {
      return status;
    }
    if (performance.now() >= deadline) {
      throw new RelayError(
        ready ? "SERVER_NOT_READY" : "SERVER_STOP_TIMEOUT",
        ready ? messages.notReady : messages.stopTimeout,
        4,
        { instanceId: launch.instanceId, status },
      );
    }
    try {
      await pause(Math.min(50, Math.max(1, deadline - performance.now())), undefined, {
        signal: environment.signal,
      });
    } catch {
      checkServerCancellation(environment);
    }
  }
}

/**
 * Останавливает конкретную регистрацию через authenticated control и её native owner.
 * После free получает lease для очистки stale endpoint; сохранённый PID никогда не используется.
 */
async function stopLaunch(
  launch: ServerLaunch,
  environment: ServerEnvironment,
): Promise<ServerInstanceStatus> {
  const endpoint = readServerEndpoint(launch);
  if (endpoint && probeServerLease(launch) === "busy") {
    await serverControl(endpoint, "stop", environment);
  }
  if (launch.mode === "service") {
    await controlServerService("disable", launch, environment);
  }
  await waitServer(launch, environment, false);
  const lock = acquireLocalLock(join(dirname(launch.path), "ownership.sqlite"));
  try {
    const current = readServerEndpoint(launch);
    if (current) {
      // Native manager мог сменить boot до disable; free mutex доказывает отсутствие любого owner этого UUID.
      rmSync(join(dirname(launch.path), "endpoint.json"));
    }
  } finally {
    lock.release();
  }
  return probeServerInstance(launch, environment);
}

/**
 * Сериализует start/stop/restart конкретной регистрации межпроцессным mutex, удерживая его через await.
 */
async function withServerAction<T>(launch: ServerLaunch, action: () => Promise<T>): Promise<T> {
  const lock = acquireLocalLock(join(dirname(launch.path), "action.sqlite"));
  try {
    return await action();
  } finally {
    lock.release();
  }
}

/**
 * Обновляет только launch остановленного экземпляра; restart после foreground получает native-владельца.
 */
function publishRestart(launch: ServerLaunch, version: string): ServerLaunch {
  const lock = acquireLocalLock(join(dirname(launch.path), "ownership.sqlite"));
  const next: ServerLaunch = { ...launch, mode: "service", version };
  const temporary = join(dirname(launch.path), `${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, JSON.stringify(next), { flag: "wx", mode: 0o600 });
    replaceLocalFile(temporary, launch.path);
  } finally {
    try {
      rmSync(temporary, { force: true });
    } finally {
      lock.release();
    }
  }
  return next;
}

/**
 * Передаёт уже проверенный loopback URL системному обработчику браузера без shell.
 * Браузер — приложение пользователя, а не потомок жизненного цикла Relay: guardian к нему не применяется.
 * Сам короткий launcher имеет deadline и принадлежащий вызову process handle; server не detach-ится.
 */
async function openBrowser(url: string, environment: ServerEnvironment): Promise<void> {
  checkServerCancellation(environment);
  const command = nativeBrowserCommand(url, environment.platform);
  const child = Bun.spawn([...command], {
    cwd: environment.cwd,
    env: environment.env,
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  });
  const deadline = setTimeout(() => child.kill("SIGKILL"), environment.timeoutMs ?? 10_000);
  /**
   * Отменяет только собственный launcher по process handle, не затрагивая браузер/сервер по PID из файлов.
   */
  const abort = (): void => {
    child.kill("SIGKILL");
  };
  environment.signal?.addEventListener("abort", abort, { once: true });
  try {
    const exitCode = await child.exited;
    checkServerCancellation(environment);
    if (exitCode !== 0) {
      throw new RelayError("SERVER_BROWSER_FAILED", messages.managerFailed, 4, { url, exitCode });
    }
  } finally {
    clearTimeout(deadline);
    environment.signal?.removeEventListener("abort", abort);
  }
}

/**
 * Создаёт ленивый локальный клиент управления независимыми серверами одного явного home.
 * list/stop не требуют проекта или установленного binary; start/run проверяют совместимый выпуск.
 */
export function createServerClient(environment: ServerEnvironment): ServerClient {
  return {
    /**
     * Явно устанавливает native user-service нового UUID и подтверждает готовность health.
     */
    async start(options, input): Promise<ServerInstanceStatus> {
      const binary = await discoverServerBinary(environment);
      const launch = createServerLaunch(options, {
        ...input,
        version: environment.version,
        mode: "service",
      });
      return withServerAction(launch, async () => {
        await controlServerService("enable", launch, environment, binary);
        return waitServer(launch, environment, true);
      });
    },
    /**
     * Передаёт stdin-lease и потоки foreground; guardian очищает принадлежащее дерево при любом exit.
     */
    async run(options, input): Promise<void> {
      const binary = await discoverServerBinary(environment);
      const launch = createServerLaunch(options, {
        ...input,
        version: environment.version,
        mode: "foreground",
      });
      const result = await (environment.runner ?? runNativeProcess)({
        executable: binary,
        args: ["run", "--launch", launch.path, "--parent-lease"],
        cwd: environment.cwd,
        env: environment.env,
        timeoutMs: null,
        stdinLease: true,
        ...(environment.signal ? { signal: environment.signal } : {}),
        ...(environment.stdout ? { stdout: environment.stdout } : {}),
        ...(environment.stderr ? { stderr: environment.stderr } : {}),
      });
      if (result.exitCode !== 0) {
        throw new RelayError("SERVER_PROCESS_FAILED", messages.processFailed, result.exitCode, {
          instanceId: launch.instanceId,
          stderr: result.stderr,
        });
      }
    },
    /**
     * Перечисляет health-наблюдения без открытия проектных баз в CLI.
     */
    list: (options, instanceId): Promise<ServerInstanceList> =>
      listServerInstances(options, environment, instanceId),
    /**
     * Останавливает один UUID, сериализуя конкурентные команды CLI.
     */
    async stop(options, instanceId): Promise<ServerInstanceStatus> {
      const launch = selectedLaunch(options, instanceId);
      return withServerAction(launch, () => stopLaunch(launch, environment));
    },
    /**
     * Проверяет binary до остановки, затем заменяет launch и ждёт health нового boot.
     */
    async restart(options, instanceId): Promise<ServerInstanceStatus> {
      const binary = await discoverServerBinary(environment);
      const launch = selectedLaunch(options, instanceId);
      return withServerAction(launch, async () => {
        await stopLaunch(launch, environment);
        const next = publishRestart(launch, environment.version);
        await controlServerService("enable", next, environment, binary);
        return waitServer(next, environment, true);
      });
    },
    /**
     * Отклоняет неоднозначность нескольких ready экземпляров вместо выбора случайного URL.
     */
    async open(options, instanceId): Promise<ServerInstanceStatus> {
      const list = await listServerInstances(options, environment, instanceId);
      const ready = list.items.filter((item) => item.state === "ready");
      if (ready.length !== 1 || !ready[0]?.url) {
        throw new RelayError(
          ready.length > 1 ? "SERVER_AMBIGUOUS" : "SERVER_NOT_READY",
          ready.length > 1 ? messages.ambiguous : messages.noReady,
          4,
        );
      }
      await openBrowser(ready[0].url, environment);
      return ready[0];
    },
  };
}
