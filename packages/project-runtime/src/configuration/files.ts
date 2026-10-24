import { randomUUID } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  linkSync,
  lstatSync,
  openSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { RelayError } from "@relay/contracts";
import { configMessages } from "./config.messages";
import type { ProjectConfig, WorkspaceConfig } from "./config.types";
import { fileMessages } from "./files.messages";
import { replaceLocalFile } from "../local-files/replace";

// SQLite удерживает межпроцессный замок за соединением: авария владельца
// освобождает его без эвристик времени жизни и удаления чужой блокировки.
export { withLocalFileLock as withWorkspaceLock } from "@relay/storage";

/**
 * Распознаёт код системной ошибки без приведения неизвестного значения к Error.
 */
export function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

/**
 * Проверяет занятость пути, включая битую символьную ссылку; только ENOENT означает отсутствие.
 */
export function fileExists(path: string): boolean {
  try {
    // Повреждённая символьная ссылка тоже является конфигом: её нельзя затереть.
    lstatSync(path);
    return true;
  } catch (error) {
    if (hasCode(error, "ENOENT")) {
      return false;
    }
    throw error;
  }
}

/**
 * Сохраняет предметные ошибки и преобразует остальные отказы синхронной операции в IO_ERROR.
 * Исходное исключение доступно как cause, а его пояснение остаётся в пользовательском тексте.
 */
export function withFileErrors<T>(operation: () => T): T {
  try {
    return operation();
  } catch (error) {
    if (error instanceof RelayError) {
      throw error;
    }
    const failure = new RelayError(
      "IO_ERROR",
      fileMessages.localStorageFailure(error instanceof Error ? error.message : String(error)),
      1,
    );
    Object.defineProperty(failure, "cause", {
      value: error,
      writable: true,
      configurable: true,
    });
    throw failure;
  }
}

/**
 * Описывает отказ заменить уже занятый путь при начальной публикации.
 */
export function configExists(path: string): RelayError {
  return new RelayError("CONFIG_EXISTS", configMessages.configExists(path), 4, { path });
}

/**
 * Публикует полностью записанный и синхронизированный JSON через соседний временный файл.
 * create использует эксклюзивный link и даёт CONFIG_EXISTS при гонке; replace использует rename.
 * Для read-modify-write вызывающий удерживает mutex до завершения публикации.
 * Уборка временного файла не отменяет успех: конфиг уже может ссылаться на созданную базу.
 */
export function writeJsonAtomic(
  path: string,
  value: ProjectConfig | WorkspaceConfig,
  publication: "create" | "replace",
): void {
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
    if (publication === "create") {
      try {
        linkSync(temporary, path);
      } catch (error) {
        if (hasCode(error, "EEXIST")) {
          throw configExists(path);
        }
        throw error;
      }
    } else {
      replaceLocalFile(temporary, path);
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
