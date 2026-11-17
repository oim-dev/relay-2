import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { observeParentProcess, type ParentProcessObservation } from "@relay/project-runtime";

/**
 * Передаёт барьер после capture; stdout наследуется ребёнком напрямую от test runner через wrapper.
 */
async function ready(observation: ParentProcessObservation, parentPid: number): Promise<void> {
  await Bun.write(
    Bun.stdout,
    `${JSON.stringify({
      phase: "ready",
      observerPid: process.pid,
      parentPid,
      aborted: observation.signal.aborted,
    })}\n`,
  );
}

/**
 * Создаёт настоящее родство wrapper → observer без guardian, stdin-lease или EOF-обработчика.
 * Test runner завершает wrapper; наблюдающий ребёнок обязан самостоятельно закончить работу.
 */
async function wrapper(directory: string): Promise<void> {
  const child = Bun.spawn([process.execPath, import.meta.path, "observe", directory], {
    cwd: directory,
    env: process.env,
    stdin: "ignore",
    stdout: "inherit",
    stderr: "inherit",
  });
  // PID принадлежит только этому fixture; нужен страховочной уборке, не проверяемой реализации.
  writeFileSync(join(directory, "observer.pid"), String(child.pid));
  process.exitCode = await child.exited;
}

/**
 * Оставляет живую работу до abort. Cleanup снимает её и оба dispose, затем процесс выходит сам.
 * Явного process.exit нет: оставленный ref-таймер проявится как незавершённый worker.
 */
async function observe(): Promise<void> {
  const parentPid = process.ppid;
  const observation = observeParentProcess();
  const keepAlive = setInterval(() => {}, 1000);
  try {
    const stopped = observation.signal.aborted
      ? Promise.resolve()
      : new Promise<void>((resolve) =>
          observation.signal.addEventListener("abort", () => resolve(), { once: true }),
        );
    await ready(observation, parentPid);
    await stopped;
  } finally {
    clearInterval(keepAlive);
    observation.dispose();
    observation.dispose();
  }
  await Bun.write(
    Bun.stdout,
    `${JSON.stringify({ phase: "aborted", reason: observation.signal.reason })}\n`,
  );
}

/**
 * Короткий процесс с живым родителем проверяет unref либо идемпотентный dispose без abort.
 * После ready не остаётся другой работы, способной удержать event loop.
 */
async function idle(dispose: boolean): Promise<void> {
  const parentPid = process.ppid;
  const observation = observeParentProcess();
  if (dispose) {
    observation.dispose();
    observation.dispose();
  }
  await ready(observation, parentPid);
}

const mode = process.argv[2];
const directory = process.argv[3];
if (!directory) {
  throw new Error("Не передан каталог parent-observation fixture");
}
if (mode === "wrapper") {
  await wrapper(directory);
} else if (mode === "observe") {
  await observe();
} else if (mode === "idle" || mode === "disposed") {
  await idle(mode === "disposed");
} else {
  throw new Error(`Неизвестная роль наблюдателя: ${mode}`);
}
