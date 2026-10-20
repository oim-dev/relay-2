import { randomUUID } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  linkSync,
  lstatSync,
  openSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { RelayError } from "@relay/contracts";

// SQLite удерживает межпроцессный замок за соединением: авария владельца
// освобождает его без эвристик времени жизни и удаления чужой блокировки.
export { withLocalFileLock as withWorkspaceLock } from "@relay/storage";

export function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

export function fileExists(path: string): boolean {
  try {
    // Повреждённая символьная ссылка тоже является конфигом: её нельзя затереть.
    lstatSync(path);
    return true;
  } catch (error) {
    if (hasCode(error, "ENOENT")) return false;
    throw error;
  }
}

export function withFileErrors<T>(operation: () => T): T {
  try {
    return operation();
  } catch (error) {
    if (error instanceof RelayError) throw error;
    throw new RelayError(
      "IO_ERROR",
      `Ошибка локального хранилища: ${error instanceof Error ? error.message : String(error)}`,
      1,
    );
  }
}

export function configExists(path: string): RelayError {
  return new RelayError("CONFIG_EXISTS", `Конфигурация уже существует: ${path}`, 4, { path });
}

export function writeJsonAtomic(path: string, value: unknown, create: boolean): void {
  const temporary = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  const descriptor = openSync(temporary, "wx", 0o600);
  try {
    try {
      writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`, "utf8");
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    // Читатель видит только целый JSON. Начальная публикация дополнительно
    // запрещает замену файла, созданного другим процессом после нашей проверки.
    if (create) {
      try {
        linkSync(temporary, path);
      } catch (error) {
        if (hasCode(error, "EEXIST")) throw configExists(path);
        throw error;
      }
    } else {
      renameSync(temporary, path);
    }
  } finally {
    try {
      unlinkSync(temporary);
    } catch {
      // После rename временного файла уже нет. Ошибка уборки после успешной
      // публикации не должна запустить откат базы, на которую ссылается конфиг.
    }
  }
}
