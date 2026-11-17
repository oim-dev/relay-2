import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { RuntimeFixture } from "./helpers/runtime-fixture";
import { running } from "./helpers/native/process-observation";
import type { WorkerResult } from "./helpers/worker.types";
import type {
  ParentObservationReady,
  ParentObservationWorker,
} from "./helpers/parent-observation-fixture.types";

// Ready, drain и независимое наблюдение exit имеют deadlines; runner оставляет бюджет fallback cleanup.
const PROCESS_TEST_TIMEOUT_MS = 25_000;

const idleCases = [
  { name: "активное наблюдение не удерживает event loop", mode: "idle" },
  { name: "повторный dispose не отменяет signal и допускает выход", mode: "disposed" },
] as const;

/**
 * Ожидает процессный барьер с deadline; таймер всегда снимается, cleanup выполняет владелец fixture.
 */
async function bounded<T>(operation: Promise<T>, timeoutMs = 5000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("Наблюдатель родителя не завершил процессный барьер")),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Декодирует сообщение, подтверждающее PID и состояние установленного наблюдателя.
 */
function decodeReady(line: string): ParentObservationReady {
  const message: unknown = JSON.parse(line);
  if (
    message === null ||
    typeof message !== "object" ||
    !("phase" in message) ||
    message.phase !== "ready" ||
    !("observerPid" in message) ||
    typeof message.observerPid !== "number" ||
    !("parentPid" in message) ||
    typeof message.parentPid !== "number" ||
    !Number.isSafeInteger(message.observerPid) ||
    message.observerPid <= 1 ||
    !Number.isSafeInteger(message.parentPid) ||
    message.parentPid < 1 ||
    !("aborted" in message) ||
    typeof message.aborted !== "boolean"
  ) {
    throw new Error(`Некорректный ready наблюдателя: ${line}`);
  }
  return {
    phase: "ready",
    observerPid: message.observerPid,
    parentPid: message.parentPid,
    aborted: message.aborted,
  };
}

/**
 * Дренирует stdout весь lifetime, выделяя первый JSON по строке, а не по границе pipe chunk.
 */
async function readOutput(
  stream: ReadableStream<Uint8Array>,
  ready: (value: ParentObservationReady) => void,
): Promise<string> {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let text = "";
  let reported = false;
  for await (const chunk of stream) {
    text += decoder.decode(chunk, { stream: true });
    const end = text.indexOf("\n");
    if (!reported && end >= 0) {
      ready(decodeReady(text.slice(0, end)));
      reported = true;
    }
  }
  return text + decoder.decode();
}

/**
 * Запускает только два уровня Bun для wrapper-сценария либо один короткий child для unref/dispose.
 * Файлы и process handle принадлежат RuntimeFixture; inherited stdout/stderr читаются до EOF.
 */
function startWorker(
  fixture: RuntimeFixture,
  mode: "wrapper" | "idle" | "disposed",
): ParentObservationWorker {
  const child = Bun.spawn(
    [
      process.execPath,
      join(import.meta.dir, "helpers/parent-observation-worker.ts"),
      mode,
      fixture.root,
    ],
    {
      cwd: fixture.cwd,
      env: { HOME: fixture.root, USERPROFILE: fixture.root, RELAY_HOME: fixture.home, PATH: "" },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  fixture.trackChild(child);
  const ready = Promise.withResolvers<ParentObservationReady>();
  const result = Promise.all([
    child.exited,
    readOutput(child.stdout, ready.resolve),
    new Response(child.stderr).text(),
  ]).then(([exit, stdout, stderr]): WorkerResult => ({ exit, stdout, stderr }));
  void result.then(
    (output) => ready.reject(new Error(`Процесс завершился до ready: ${JSON.stringify(output)}`)),
    ready.reject,
  );
  return { child, ready: ready.promise, result };
}

/**
 * Наблюдает реальный exit внука независимо от проверяемого API; EOF pipe сам по себе его не доказывает.
 */
async function waitForExit(pid: number): Promise<void> {
  const deadline = performance.now() + 5000;
  while (running(pid)) {
    if (performance.now() >= deadline) {
      throw new Error(`Остался жив наблюдатель fixture ${pid}`);
    }
    await Bun.sleep(10);
  }
}

/**
 * Читает только PID собственного внука, опубликованный wrapper; рабочие Server PID не используются.
 */
function observerPid(fixture: RuntimeFixture): number | undefined {
  const path = join(fixture.root, "observer.pid");
  if (!existsSync(path)) {
    return undefined;
  }
  const pid = Number(readFileSync(path, "utf8"));
  if (!Number.isSafeInteger(pid) || pid <= 1) {
    throw new Error("Повреждён PID собственного наблюдателя");
  }
  return pid;
}

/**
 * Только после assertions страховочно убирает собственный orphan и wrapper, затем дренирует pipes.
 * При успешном сценарии оба процесса уже мертвы; fallback не может скрыть отсутствие abort/cleanup.
 */
async function disposeWorker(
  fixture: RuntimeFixture,
  worker: ParentObservationWorker,
): Promise<void> {
  try {
    const pid = observerPid(fixture);
    if (pid !== undefined && running(pid)) {
      try {
        process.kill(pid, "SIGKILL");
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) {
          throw error;
        }
      }
      await waitForExit(pid);
    }
  } finally {
    await fixture.dispose();
    await bounded(worker.result);
  }
}

describe("Наблюдение lifetime непосредственного родителя", () => {
  test(
    "SIGKILL настоящего wrapper даёт parent-exited и ребёнок заканчивает cleanup без orphan",
    async () => {
      const fixture = new RuntimeFixture("dev-mode-test-review/parent-observation");
      let worker: ParentObservationWorker | undefined;
      try {
        worker = startWorker(fixture, "wrapper");
        const ready = await bounded(worker.ready);
        expect(ready).toMatchObject({ parentPid: worker.child.pid, aborted: false });
        expect(observerPid(fixture)).toBe(ready.observerPid);
        expect(running(ready.observerPid)).toBe(true);

        worker.child.kill("SIGKILL");
        const result = await bounded(worker.result);
        await waitForExit(ready.observerPid);

        expect(result.exit).not.toBe(0);
        expect(result.stderr).toBe("");
        expect(
          result.stdout
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line)),
        ).toEqual([
          {
            phase: "ready",
            observerPid: ready.observerPid,
            parentPid: worker.child.pid,
            aborted: false,
          },
          { phase: "aborted", reason: "parent-exited" },
        ]);
        expect(running(worker.child.pid)).toBe(false);
        expect(running(ready.observerPid)).toBe(false);
      } finally {
        if (worker === undefined) {
          await fixture.dispose();
        } else {
          await disposeWorker(fixture, worker);
        }
      }
    },
    PROCESS_TEST_TIMEOUT_MS,
  );

  test.each(idleCases)(
    "при живом родителе $name",
    async ({ mode }) => {
      const fixture = new RuntimeFixture("dev-mode-test-review/parent-observation");
      let worker: ParentObservationWorker | undefined;
      try {
        worker = startWorker(fixture, mode);
        const ready = await bounded(worker.ready);
        const result = await bounded(worker.result);

        expect(ready).toEqual({
          phase: "ready",
          observerPid: worker.child.pid,
          parentPid: process.pid,
          aborted: false,
        });
        expect(result).toEqual({ exit: 0, stdout: `${JSON.stringify(ready)}\n`, stderr: "" });
        expect(running(worker.child.pid)).toBe(false);
      } finally {
        if (worker === undefined) {
          await fixture.dispose();
        } else {
          await disposeWorker(fixture, worker);
        }
      }
    },
    PROCESS_TEST_TIMEOUT_MS,
  );
});
