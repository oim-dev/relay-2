import { expect } from "bun:test";
import { join } from "node:path";
import type { RuntimeFixture } from "./runtime-fixture";
import { workerMessages } from "./worker.messages";
import type {
  InitializationWorkerInput,
  RegistrationWorkerInput,
  RunningWorker,
  WorkerResult,
} from "./worker.types";

const WORKER_TIMEOUT_MS = 10_000;

/**
 * Запускает worker с deadline и IPC, сразу читает потоки и передаёт очистку fixture.
 * onReady вызывается на каждом барьере; к этому моменту объект worker уже создан.
 */
function launchWorker(
  fixture: RuntimeFixture,
  script: "initialization-worker.ts" | "registration-worker.ts",
  input: InitializationWorkerInput | RegistrationWorkerInput,
  onReady: (worker: RunningWorker) => void,
  env: Readonly<Record<string, string | undefined>> = process.env,
): RunningWorker {
  const child = Bun.spawn({
    cmd: [process.execPath, join(import.meta.dir, "..", script), JSON.stringify(input)],
    cwd: fixture.root,
    env,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    timeout: WORKER_TIMEOUT_MS,
    /**
     * Передаёт сигнал готовности участника координатору барьера.
     */
    ipc(message: unknown): void {
      if (message === "ready") {
        onReady(worker);
      }
    },
  });
  fixture.trackChild(child);
  if (!("synchronizePublication" in input) || input.synchronizePublication !== true) {
    void child.stdin.end();
  }
  const result = Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]).then(([exit, stdout, stderr]): WorkerResult => ({ exit, stdout, stderr }));
  const worker: RunningWorker = { child, result };
  return worker;
}

/**
 * Дожидается первого барьера worker; раннее завершение отклоняет ожидание с диагностикой.
 */
function startWorker(
  fixture: RuntimeFixture,
  script: "initialization-worker.ts" | "registration-worker.ts",
  input: InitializationWorkerInput | RegistrationWorkerInput,
  env?: Readonly<Record<string, string | undefined>>,
): Promise<RunningWorker> {
  return new Promise((resolve, reject) => {
    const worker = launchWorker(fixture, script, input, resolve, env);
    void worker.result.then(({ exit, stderr }) => {
      reject(new Error(workerMessages.exitedBeforeReady(exit, stderr)));
    }, reject);
  });
}

/**
 * Подготавливает init к барьеру: обычный ждёт go, синхронизированный — открытия stdin
 * после создания базы. Второй режим гарантирует конкуренцию именно за публикацию конфига.
 */
export function startInitializationWorker(
  fixture: RuntimeFixture,
  input: InitializationWorkerInput,
  env?: Readonly<Record<string, string | undefined>>,
): Promise<RunningWorker> {
  return startWorker(fixture, "initialization-worker.ts", input, env);
}

/**
 * Запускает непрерывного читателя; тест останавливает его сообщением stop и проверяет результат.
 */
export async function startWorkspaceReader(
  fixture: RuntimeFixture,
  input: RegistrationWorkerInput,
): Promise<RunningWorker> {
  const reader = await startWorker(fixture, "registration-worker.ts", input);
  reader.child.send("go");
  return reader;
}

/**
 * Согласует два реальных писателя на каждой операции read-modify-write и проверяет их завершение.
 * Следующий шаг обоих участников начинается только после получения двух сигналов готовности.
 */
export async function runRegistrationRace(
  fixture: RuntimeFixture,
  inputs: readonly [RegistrationWorkerInput, RegistrationWorkerInput],
): Promise<void> {
  let readyCount = 0;
  const workers: RunningWorker[] = [];
  /**
   * Открывает очередной барьер только после готовности обоих писателей.
   */
  function releaseReadyWorkers(): void {
    readyCount++;
    if (readyCount === inputs.length) {
      readyCount = 0;
      for (const worker of workers) {
        worker.child.send("go");
      }
    }
  }
  for (const input of inputs) {
    workers.push(launchWorker(fixture, "registration-worker.ts", input, releaseReadyWorkers));
  }
  const results = await Promise.all(workers.map((worker) => worker.result));
  for (const result of results) {
    expect(result).toEqual({ exit: 0, stdout: "", stderr: "" });
  }
}
