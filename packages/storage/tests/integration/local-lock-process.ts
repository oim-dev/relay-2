import { readFileSync, readSync, renameSync, writeFileSync, writeSync } from "node:fs";
import { RelayError } from "@relay/contracts";
import { withLocalFileLock } from "../../src/local-lock/local-lock";
import type { ActorLog, LockProcessArguments } from "./helpers/local-lock-process.types";

/**
 * Проверяет аргументы процесса до обращения к тестовому JSON-файлу.
 */
function readArguments(args: readonly string[]): LockProcessArguments {
  const [path, mode, actor] = args;
  if (!path || (mode !== "hold" && mode !== "write") || actor === undefined) {
    throw new Error("Ожидались путь JSON, режим hold/write и автор");
  }
  return { path, mode, actor };
}

/**
 * Декодирует минимальный журнал участников; повреждение fixture не подменяется пустым журналом.
 */
function readActorLog(path: string): ActorLog {
  const value: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (
    value === null ||
    typeof value !== "object" ||
    !("actors" in value) ||
    !Array.isArray(value.actors) ||
    !value.actors.every((actor: unknown) => typeof actor === "string")
  ) {
    throw new Error("Тестовый журнал должен содержать строковый массив actors");
  }
  return { actors: value.actors };
}

/**
 * Синхронно публикует строку протокола: родитель использует её как барьер без sleep.
 */
function signal(message: string): void {
  writeSync(1, `${message}\n`);
}

/**
 * Ожидает ровно один байт разрешения; EOF не считается разрешением продолжить запись.
 */
function barrier(): void {
  if (readSync(0, Buffer.alloc(1), 0, 1, null) !== 1) {
    throw new Error("Барьер закрыт без сигнала");
  }
}

const { path, mode, actor } = readArguments(process.argv.slice(2));
signal("ready");
barrier();
signal("attempting");
try {
  withLocalFileLock(path, () => {
    const content = readActorLog(path);
    signal("locked");
    // Барьер внутри синхронного callback удерживает настоящий SQLite mutex.
    if (mode === "hold") {
      barrier();
    }
    const temporary = `${path}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify({ actors: [...content.actors, actor] }));
    renameSync(temporary, path);
  });
  signal("done");
} catch (error) {
  if (!(error instanceof RelayError)) {
    throw error;
  }
  signal(JSON.stringify({ code: error.code, exitCode: error.exitCode }));
  process.exitCode = error.exitCode;
}
