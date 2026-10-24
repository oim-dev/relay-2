import { setTimeout as pause } from "node:timers/promises";
import type { GitSyncReplica, GitSyncSupervisorProcess } from "./git-sync-fixture.types";
import type { ProcessResult } from "./workflow-fixture.types";

const readinessDeadlineMs = 15_000;
const shutdownDeadlineMs = 20_000;
const exitGraceMs = 5_000;
const readinessProbeIntervalMs = 50;

/**
 * Читает оба потока одновременно с завершением процесса, не оставляя pipe без потребителя.
 */
async function collectProcess(
  child: Pick<Bun.Subprocess<"ignore", "pipe", "pipe">, "exited" | "stdout" | "stderr">,
): Promise<ProcessResult> {
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { code, stdout, stderr };
}

/**
 * Проверяет объектную форму служебного JSON без утверждения типа его значений.
 */
function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Вызывает только служебное чтение/остановку supervisor через настоящий компонент.
 * Пользовательские действия маршрута по-прежнему выполняются через relay; native services не нужны.
 */
async function requestSupervisor(
  replica: GitSyncReplica,
  action: "supervisor.status" | "supervisor.stop",
  timeoutMs: number,
): Promise<unknown> {
  const binary = replica.variables.RELAY_GIT_SYNC_BIN;
  const home = replica.variables.RELAY_HOME;
  if (!binary || !home) {
    throw new Error("Окружение supervisor требует явные RELAY_GIT_SYNC_BIN и RELAY_HOME");
  }
  const child = Bun.spawn([binary, "--request"], {
    cwd: replica.cwd,
    env: replica.variables,
    stdin: new Blob([
      JSON.stringify({ version: 1, action, options: { cwd: replica.cwd, home }, input: {} }),
    ]),
    stdout: "pipe",
    stderr: "pipe",
    timeout: timeoutMs,
  });
  try {
    const result = await collectProcess(child);
    if (result.code !== 0 || result.stderr !== "") {
      throw new Error(`Служебный ${action} завершился с ошибкой: ${JSON.stringify(result)}`);
    }
    const response: unknown = JSON.parse(result.stdout);
    if (
      !isObject(response) ||
      response.version !== 1 ||
      response.ok !== true ||
      !("data" in response)
    ) {
      throw new Error(`Служебный ${action} не вернул успешную оболочку протокола`);
    }
    return response.data;
  } finally {
    if (child.exitCode === null) {
      child.kill();
      await child.exited;
    }
  }
}

/**
 * Ограничивает ожидание события выхода или чтения потоков; null означает истечение grace period.
 * Таймер снимается и при досрочном завершении процесса, и при ошибке потока.
 */
async function finishWithin<T>(finished: Promise<T>, timeoutMs: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      finished,
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Наблюдает реальный supervisor.status до нужного состояния либо deadline.
 * Интервал ограничивает частоту read-only проб; готовность определяют health/instance, а не задержка.
 */
async function awaitSupervisorState(
  replica: GitSyncReplica,
  state: "running" | "stopped",
  child: Pick<Bun.Subprocess, "exitCode">,
  finished: Promise<PromiseSettledResult<ProcessResult>>,
): Promise<void> {
  const deadline = Date.now() + (state === "running" ? readinessDeadlineMs : exitGraceMs);
  let observed: unknown;
  while (Date.now() < deadline) {
    if (state === "running" && child.exitCode !== null) {
      throw new Error(
        `CLI supervise завершился до готовности: ${JSON.stringify(await finishWithin(finished, exitGraceMs))}`,
      );
    }
    observed = await requestSupervisor(
      replica,
      "supervisor.status",
      Math.max(1, Math.min(2_000, deadline - Date.now())),
    );
    if (
      !isObject(observed) ||
      typeof observed.actual !== "string" ||
      typeof observed.responsive !== "boolean"
    ) {
      throw new Error("Supervisor status должен возвращать actual и responsive");
    }
    if (state === "stopped" && observed.actual === "stopped" && observed.responsive === false) {
      return;
    }
    if (
      state === "running" &&
      observed.actual === "running" &&
      observed.responsive === true &&
      typeof observed.instance === "string" &&
      observed.instance.length > 0
    ) {
      return;
    }
    await pause(Math.min(readinessProbeIntervalMs, Math.max(0, deadline - Date.now())));
  }
  throw new Error(`Supervisor не достиг ${state} до deadline: ${JSON.stringify(observed)}`);
}

/**
 * Запускает отдельный relay git-sync supervise, сразу читая его потоки.
 * close выполняет supervisor.stop и ждёт CLI; сигналы активируют guardian/parent-lease fallback.
 * Функция не устанавливает службу и не меняет условия наследования Windows Job.
 */
export function launchGitSyncSupervisor(replica: GitSyncReplica): GitSyncSupervisorProcess {
  const home = replica.variables.RELAY_HOME;
  if (!home) {
    throw new Error("Foreground supervisor требует изолированный RELAY_HOME");
  }
  const child = Bun.spawn([replica.binary, "git-sync", "supervise", "--home", home], {
    cwd: replica.cwd,
    env: replica.variables,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  // Отклонение чтения сохраняется до close, не превращаясь в unhandled rejection посреди маршрута.
  const finished = collectProcess(child).then(
    (value) => ({ status: "fulfilled", value }) as const,
    (reason: unknown) => ({ status: "rejected", reason }) as const,
  );
  return {
    /**
     * Ожидает готовность supervisor по служебному протоколу выбранного HOME.
     */
    ready(): Promise<void> {
      return awaitSupervisorState(replica, "running", child, finished);
    },
    /**
     * Завершает supervisor и весь foreground-вызов до удаления файлов fixture.
     * Ошибка graceful stop сохраняется даже после успешной аварийной остановки.
     */
    async close(): Promise<void> {
      const failures: unknown[] = [];
      let stopRequested = false;
      if (child.exitCode === null) {
        try {
          const result = await requestSupervisor(replica, "supervisor.stop", shutdownDeadlineMs);
          if (!isObject(result) || result.stopped !== true) {
            throw new Error("Supervisor stop должен подтвердить stopped: true");
          }
          stopRequested = true;
        } catch (error) {
          failures.push(error);
        }
      }
      let exitCode = await finishWithin(child.exited, exitGraceMs);
      for (const signal of ["SIGTERM", "SIGKILL"] as const) {
        if (exitCode !== null) {
          break;
        }
        child.kill(signal);
        exitCode = await finishWithin(child.exited, exitGraceMs);
      }
      if (exitCode === null) {
        throw new Error("Foreground CLI не завершился после остановки supervisor и сигналов");
      }
      const result = await finishWithin(finished, exitGraceMs);
      await awaitSupervisorState(replica, "stopped", child, finished);
      if (result === null) {
        failures.push(new Error("Потоки foreground CLI не закрылись после выхода процесса"));
      } else if (result.status === "rejected") {
        failures.push(result.reason);
      } else if (stopRequested && result.value.code !== 0) {
        failures.push(
          new Error(`Foreground CLI завершился с ошибкой: ${JSON.stringify(result.value)}`),
        );
      }
      if (failures.length > 0) {
        throw new AggregateError(failures, "Ошибка остановки foreground supervisor");
      }
    },
  };
}
