import { RelayError, type GitSyncResponse } from "@relay/contracts";
import { redact } from "../transport/process";
import { appMessages } from "./app.messages";

/**
 * Редактирует только строковые значения, сохраняя JSON-структуру диагностики и ключи её контракта.
 * Обход создаёт новые объекты; исходные details владельца ошибки не изменяются.
 */
function redactValue(value: unknown): unknown {
  if (typeof value === "string") {
    return redact(value);
  }
  if (Array.isArray(value)) {
    return value.map(redactValue);
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactValue(item)]));
  }
  return value;
}

/**
 * Преобразует отказ в единственный процессный ответ; внутренние исключения не выдают stack/секреты.
 */
export function failure(error: unknown): Extract<GitSyncResponse, { ok: false }> {
  if (error instanceof RelayError) {
    const details =
      error.details === undefined
        ? undefined
        : Object.fromEntries(
            Object.entries(error.details).map(([key, value]) => [key, redactValue(value)]),
          );
    return {
      version: 1,
      ok: false,
      error: {
        code: error.code,
        message: redact(error.message),
        exitCode: error.exitCode,
        ...(details === undefined ? {} : { details }),
      },
    };
  }
  return {
    version: 1,
    ok: false,
    error: { code: "GIT_SYNC_ERROR", message: appMessages.internal, exitCode: 1 },
  };
}

/**
 * Восстанавливает стабильную ошибку другого локального процесса без повторного исполнения команды.
 */
export function responseData(response: GitSyncResponse): unknown {
  if (!response.ok) {
    throw new RelayError(
      response.error.code,
      response.error.message,
      response.error.exitCode,
      response.error.details,
    );
  }
  return response.data;
}
