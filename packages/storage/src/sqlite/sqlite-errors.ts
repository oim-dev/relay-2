import { RelayError } from "@relay/contracts";
import { sqliteMessages } from "./sqlite.messages";

/**
 * Извлекает строковый код ошибки драйвера или файловой системы без утверждения её формы.
 */
export function errorCode(error: unknown): string {
  if (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    typeof error.code === "string"
  ) {
    return error.code;
  }
  return "";
}

/**
 * Преобразует технический отказ БД в RelayError, сохраняя исходную причину.
 * Ошибки сценария без технического кода возвращаются с исходной идентичностью и стеком.
 */
export function storageError(error: unknown, path: string): Error {
  if (error instanceof RelayError) {
    return error;
  }
  const code = errorCode(error);
  if (error instanceof Error && !code) {
    return error;
  }

  let converted: RelayError;
  if (code.startsWith("SQLITE_BUSY") || code.startsWith("SQLITE_LOCKED")) {
    converted = new RelayError("STORAGE_BUSY", sqliteMessages.busy, 4, { path });
  } else if (code.startsWith("SQLITE_CONSTRAINT")) {
    converted = new RelayError("CONFLICT", sqliteMessages.integrityConflict, 4, {
      path,
      reason: error instanceof Error ? error.message : String(error),
    });
  } else {
    converted = new RelayError("STORAGE_ERROR", sqliteMessages.databaseError, 1, {
      path,
      reason: error instanceof Error ? error.message : String(error),
    });
  }
  converted.cause = error;
  return converted;
}
