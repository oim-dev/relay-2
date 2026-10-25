import { expect } from "bun:test";
import { EventEmitter, on } from "node:events";
import { join } from "node:path";
import type { RuntimeFixture } from "./runtime-fixture";
import { readRegistrationEvent } from "./worker-protocol";
import { workerMessages } from "./worker.messages";
import type {
  InitializationWorkerInput,
  RegistrationWorkerInput,
  RegistrationWorkerEvent,
  RunningRegistrationWorker,
  RunningWorker,
  WorkerResult,
} from "./worker.types";

const WORKER_TIMEOUT_MS = 10_000;

/**
 * Читает синхронный ready из stdout init до его блокирующего stdin-барьера, затем собирает ответ.
 * Поток непрерывно дренируется; служебная строка не попадает в JSON результата init.
 */
async function readPublicationOutput(
  stdout: ReadableStream<Uint8Array>,
  onReady: () => void,
): Promise<string> {
  const decoder = new TextDecoder();
  let output = "";
  let ready = false;
  for await (const chunk of stdout) {
    output += decoder.decode(chunk, { stream: true });
    if (!ready && output.includes("\n")) {
      if (!output.startsWith("ready\n")) {
        throw new Error(`Некорректный барьер публикации init: ${output}`);
      }
      output = output.slice("ready\n".length);
      ready = true;
      onReady();
    }
  }
  return output + decoder.decode();
}

/**
 * Запускает worker с deadline и IPC, сразу читает потоки и передаёт очистку fixture.
 * onMessage вызывается на каждом сообщении; к этому моменту объект worker уже создан.
 * Трасса сохраняет входные параметры, фазы, команды и exit до проверки результата.
 */
function launchWorker(
  fixture: RuntimeFixture,
  script: "initialization-worker.ts" | "registration-worker.ts",
  input: InitializationWorkerInput | RegistrationWorkerInput,
  onMessage: (worker: RunningWorker, message: unknown) => void,
  env: Readonly<Record<string, string | undefined>> = process.env,
): RunningWorker {
  const started = performance.now();
  const trace = [`spawn ${script} ${JSON.stringify(input)}`];
  /**
   * Добавляет фазу процесса с монотонным временем от запуска для диагностики deadline.
   */
  function record(event: string, value: unknown): void {
    trace.push(`${(performance.now() - started).toFixed(1)}ms ${event} ${JSON.stringify(value)}`);
  }
  const child = Bun.spawn({
    cmd: [process.execPath, join(import.meta.dir, "..", script), JSON.stringify(input)],
    cwd: fixture.root,
    env,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    timeout: WORKER_TIMEOUT_MS,
    /**
     * Сохраняет фазу перед передачей координатору барьера.
     */
    ipc(message: unknown): void {
      record("received", message);
      onMessage(worker, message);
    },
    /**
     * Фиксирует разрыв канала отдельно от завершения и дренирования потоков.
     */
    onDisconnect(): void {
      record("disconnected", null);
    },
  });
  fixture.trackChild(child);
  if (!("synchronizePublication" in input) || input.synchronizePublication !== true) {
    void child.stdin.end();
  }
  const stdout =
    "synchronizePublication" in input && input.synchronizePublication === true
      ? readPublicationOutput(child.stdout, () => onMessage(worker, "ready"))
      : new Response(child.stdout).text();
  const exited = child.exited.then((exit) => {
    record("exit", { exit, signalCode: child.signalCode });
    return exit;
  });
  const result = Promise.all([exited, stdout, new Response(child.stderr).text()]).then(
    ([exit, stdout, stderr]): WorkerResult => {
      record("drained", { exit });
      return { exit, stdout, stderr };
    },
  );
  const worker: RunningWorker = {
    child,
    result,
    trace,
    /**
     * Записывает команду до передачи дочернему процессу, сохраняя также отказ отправки.
     */
    send(message: unknown): void {
      record("sent", message);
      child.send(message);
    },
  };
  return worker;
}

/**
 * Подготавливает init к барьеру: обычный ждёт go, синхронизированный — открытия stdin
 * после создания базы. Второй режим гарантирует конкуренцию именно за публикацию конфига.
 * Раннее завершение отклоняет ожидание с диагностикой.
 */
export function startInitializationWorker(
  fixture: RuntimeFixture,
  input: InitializationWorkerInput,
  env?: Readonly<Record<string, string | undefined>>,
): Promise<RunningWorker> {
  return new Promise((resolve, reject) => {
    const worker = launchWorker(
      fixture,
      "initialization-worker.ts",
      input,
      (worker, message) => {
        if (message === "ready") {
          resolve(worker);
        }
      },
      env,
    );
    void worker.result.then(({ exit, stderr }) => {
      reject(new Error(workerMessages.exitedBeforeReady(exit, stderr)));
    }, reject);
  });
}

/**
 * Запускает workspace worker с очередью всех фаз; fixture владеет процессом до завершения.
 * Подписка создаётся до spawn, поэтому ранний ready и соседние сообщения не теряются между await.
 */
export function startRegistrationWorker(
  fixture: RuntimeFixture,
  input: RegistrationWorkerInput,
): RunningRegistrationWorker {
  const mailbox = new EventEmitter();
  const messages: AsyncIterableIterator<unknown[]> = on(mailbox, "message", { close: ["exit"] });
  const worker = launchWorker(fixture, "registration-worker.ts", input, (_worker, message) => {
    mailbox.emit("message", message);
  });
  void worker.result.then(
    () => mailbox.emit("exit"),
    (error: unknown) => mailbox.emit("error", error),
  );
  return {
    ...worker,
    /**
     * Проверяет следующую фазу либо сообщает ранний exit вместе с уже дренированными потоками.
     */
    async nextEvent(): Promise<RegistrationWorkerEvent> {
      const message = await messages.next();
      if (message.done) {
        throw new Error(
          `Worker завершился до ожидаемой фазы: ${JSON.stringify({ trace: worker.trace, result: await worker.result })}`,
        );
      }
      return readRegistrationEvent(message.value[0]);
    },
  };
}

/**
 * Проверяет конкретную фазу участника; ошибка показывает его команды и последний завершённый шаг.
 */
export async function expectRegistrationEvent(
  worker: RunningRegistrationWorker,
  expected: RegistrationWorkerEvent,
): Promise<void> {
  expect(await worker.nextEvent(), worker.trace.join("\n")).toEqual(expected);
}

/**
 * Дожидается первого проверенного снимка непрерывного читателя перед запуском писателей.
 */
export async function startWorkspaceReader(
  fixture: RuntimeFixture,
  input: RegistrationWorkerInput,
): Promise<RunningRegistrationWorker> {
  const reader = startRegistrationWorker(fixture, input);
  await expectRegistrationEvent(reader, { phase: "ready", index: 0 });
  reader.send({ kind: "go", index: 0 });
  await expectRegistrationEvent(reader, { phase: "reading" });
  return reader;
}

/**
 * Останавливает читателя, принимает число целых снимков и завершает handshake до проверки exit/потоков.
 */
export async function stopWorkspaceReader(reader: RunningRegistrationWorker): Promise<void> {
  reader.send({ kind: "stop" });
  const event = await reader.nextEvent();
  expect(event.phase, reader.trace.join("\n")).toBe("stopped");
  if (event.phase !== "stopped") {
    throw new Error("Читатель не подтвердил остановку");
  }
  expect(event.snapshots).toBeGreaterThan(0);
  reader.send({ kind: "finish" });
  expect(await reader.result, reader.trace.join("\n")).toEqual({ exit: 0, stdout: "", stderr: "" });
}

/**
 * Согласует два реальных писателя на каждой операции read-modify-write и проверяет их завершение.
 * Каждый барьер принадлежит конкретному участнику и индексу; последний результат подтверждается
 * до закрытия IPC. Зависание сохраняет фазы обоих участников, не повторяя мутацию и не продлевая deadline.
 */
export async function runRegistrationRace(
  fixture: RuntimeFixture,
  inputs: readonly [RegistrationWorkerInput, RegistrationWorkerInput],
): Promise<void> {
  expect(inputs[0].count).toBe(inputs[1].count);
  const workers = inputs.map((input) => startRegistrationWorker(fixture, input));
  try {
    for (let index = 0; index < inputs[0].count; index++) {
      await Promise.all(
        workers.map((worker) => expectRegistrationEvent(worker, { phase: "ready", index })),
      );
      for (const worker of workers) {
        worker.send({ kind: "go", index });
      }
      await Promise.all(
        workers.map((worker) => expectRegistrationEvent(worker, { phase: "started", index })),
      );
      await Promise.all(
        workers.map((worker) => expectRegistrationEvent(worker, { phase: "completed", index })),
      );
    }
    await Promise.all(
      workers.map((worker) =>
        expectRegistrationEvent(worker, { phase: "finished", count: inputs[0].count }),
      ),
    );
    for (const worker of workers) {
      worker.send({ kind: "finish" });
    }
    const results = await Promise.all(workers.map((worker) => worker.result));
    for (const result of results) {
      expect(result).toEqual({ exit: 0, stdout: "", stderr: "" });
    }
  } catch (error) {
    console.error(`Фазы гонки workspace: ${JSON.stringify(workers.map((worker) => worker.trace))}`);
    throw error;
  }
}
