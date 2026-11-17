import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { RelayError } from "@relay/contracts";
import { hasCode } from "../configuration/files";
import { statusMessages as messages } from "./status.messages";
import type { RelayStatusError } from "./status.types";

/**
 * Канонизирует существующий путь; отсутствие сохраняет адрес для диагностики, прочие ошибки явны.
 */
export function statusPath(path: string): string {
  try {
    return realpathSync(path);
  } catch (error) {
    if (hasCode(error, "ENOENT")) {
      return resolve(path);
    }
    throw error;
  }
}

/**
 * Сохраняет независимый отказ одного элемента сводки без подмены пустыми данными.
 */
export function statusError(error: unknown): RelayStatusError {
  return {
    code: error instanceof RelayError ? error.code : "STATUS_READ_FAILED",
    message: error instanceof Error ? error.message : messages.failed,
  };
}
