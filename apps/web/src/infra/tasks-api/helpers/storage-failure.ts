import { RelayApiError } from "@relay/rest-sdk";

/**
 * Сохраняет диагностику актуального сервера, включая код ошибки хранилища.
 */
export function getStorageFailureMessage(error: unknown): string | null {
  let current = error;
  for (let depth = 0; depth < 5 && current instanceof Error; depth += 1) {
    if (
      current instanceof RelayApiError &&
      (current.code.startsWith("STORAGE_") || current.code === "INTEGRITY_ERROR")
    ) {
      return `${current.message} (${current.code})`;
    }
    current = current.cause;
  }
  return null;
}

/**
 * Отличает предметную недоступность хранилища от сетевого отказа.
 */
export function isStorageFailure(error: unknown): boolean {
  return getStorageFailureMessage(error) !== null;
}

/**
 * Показывает причину недоступности регистрации без старых команд обслуживания.
 */
export function getProjectAvailabilityMessage(error: string): string {
  return error;
}
