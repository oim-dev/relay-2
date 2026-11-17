import { fileURLToPath } from "node:url";
import { parseDevelopmentArguments } from "./dev/arguments";
import { developmentMessages as messages } from "./dev/dev.messages";
import type { ParentProcessObservation } from "@relay/project-runtime";

/* Сохраняем инициатора до ленивой загрузки Runtime: он может завершиться во время импорта. */
const parentPid = process.ppid;

/**
 * Процессный вход общего dev-запуска; сигналы принадлежат только текущей терминальной сессии.
 * Отказ наблюдения родителя сохраняется и при независимой ошибке очистки dev-команд.
 */
async function main(): Promise<void> {
  const options = parseDevelopmentArguments(process.argv.slice(2), process.cwd(), process.env);
  if (options === null) {
    console.log(messages.help);
    return;
  }
  const controller = new AbortController();
  /**
   * SIGINT запускает общий graceful shutdown вместо независимого выхода dispatcher.
   */
  const interrupt = (): void => controller.abort("SIGINT");
  /**
   * SIGTERM сохраняет исходную причину отмены для guardian.
   */
  const terminate = (): void => controller.abort("SIGTERM");
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", terminate);
  let parent: ParentProcessObservation | undefined;
  let failed = false;
  let failure: unknown;
  try {
    const { observeParentProcess } = await import("@relay/project-runtime");
    parent = observeParentProcess(parentPid);
    const { runDevelopmentSession } = await import("./dev/session");
    await runDevelopmentSession(options, {
      repository: fileURLToPath(new URL("../", import.meta.url)),
      bun: process.execPath,
      env: { ...process.env },
      signal: AbortSignal.any([controller.signal, parent.signal]),
    });
  } catch (cause) {
    failed = true;
    failure = cause;
  } finally {
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", terminate);
  }
  if (parent?.signal.aborted && parent.signal.reason !== "parent-exited") {
    failure = failed
      ? new AggregateError([parent.signal.reason, failure], messages.stopped)
      : parent.signal.reason;
    failed = true;
  }
  try {
    parent?.dispose();
  } catch (cleanup) {
    if (failed) {
      throw new AggregateError([failure, cleanup], messages.stopped);
    }
    throw cleanup;
  }
  if (failed) {
    throw failure;
  }
  console.log(messages.stopped);
}

try {
  await main();
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
