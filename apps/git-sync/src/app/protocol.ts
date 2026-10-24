import { RelayError, type GitSyncRequest, type GitSyncResponse } from "@relay/contracts";
import { appMessages } from "./app.messages";

/**
 * Проверяет форму объекта на внешней границе процессного и локального протокола.
 */
export function requestObject(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new RelayError("GIT_SYNC_INVALID_REQUEST", appMessages.invalidRequest, 2);
  }
  // Объектная форма проверена; значения полей ниже остаются unknown.
  return value as Record<string, unknown>;
}

/**
 * Проверяет обязательный непустой строковый аргумент без преобразования его значения.
 */
export function requiredString(value: unknown): string {
  if (typeof value !== "string" || !value || value.includes("\0")) {
    throw new RelayError("INVALID_ARGUMENT", appMessages.argument, 2);
  }
  return value;
}

/**
 * Читает единственный JSON-запрос с закрытой оболочкой и явным контекстом выбора проекта.
 */
export function decodeRequest(value: unknown): GitSyncRequest {
  const request = requestObject(value);
  if (request.version !== 1) {
    throw new RelayError("GIT_SYNC_PROTOCOL_VERSION", appMessages.version, 2);
  }
  if (
    Object.keys(request).some((key) => !["version", "action", "options", "input"].includes(key))
  ) {
    throw new RelayError("GIT_SYNC_INVALID_REQUEST", appMessages.invalidRequest, 2);
  }
  const options = requestObject(request.options);
  if (Object.keys(options).some((key) => !["cwd", "config", "home", "project"].includes(key))) {
    throw new RelayError("GIT_SYNC_INVALID_REQUEST", appMessages.invalidRequest, 2);
  }
  return {
    version: 1,
    action: requiredString(request.action),
    options: {
      cwd: requiredString(options.cwd),
      ...(options.config === undefined ? {} : { config: requiredString(options.config) }),
      ...(options.home === undefined ? {} : { home: requiredString(options.home) }),
      ...(options.project === undefined ? {} : { project: requiredString(options.project) }),
    },
    ...(request.input === undefined ? {} : { input: requestObject(request.input) }),
  };
}

/**
 * Проверяет оболочку ответа IPC, прежде чем доверять коду завершения и результату.
 */
export function decodeResponse(value: unknown): GitSyncResponse {
  const response = requestObject(value);
  if (response.version !== 1 || typeof response.ok !== "boolean") {
    throw new RelayError("GIT_SYNC_PROTOCOL_VERSION", appMessages.incompatible, 4);
  }
  if (response.ok) {
    return { version: 1, ok: true, data: response.data };
  }
  const error = requestObject(response.error);
  if (
    typeof error.exitCode !== "number" ||
    !Number.isSafeInteger(error.exitCode) ||
    error.exitCode < 1 ||
    error.exitCode > 255
  ) {
    throw new RelayError("GIT_SYNC_INVALID_REQUEST", appMessages.invalidRequest, 2);
  }
  return {
    version: 1,
    ok: false,
    error: {
      code: requiredString(error.code),
      message: requiredString(error.message),
      exitCode: error.exitCode,
      ...(error.details === undefined ? {} : { details: requestObject(error.details) }),
    },
  };
}
