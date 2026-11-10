import { RelayError } from "../errors/relay-error";
import type { GitSyncRequest } from "./git-sync.types";
import { gitSyncRequestMessages as messages } from "./git-sync-request.messages";

/**
 * Сужает JSON-объект оболочки, сохраняя значения полей неизвестными до отдельных проверок.
 */
function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new RelayError("GIT_SYNC_INVALID_REQUEST", messages.invalid, 2);
  }
  // Проверенная объектная форма не утверждает типы её отдельных значений.
  return value as Record<string, unknown>;
}

/**
 * Проверяет строку процессного контекста без изменения её содержимого.
 */
function text(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) {
    throw new RelayError("INVALID_ARGUMENT", messages.argument, 2);
  }
  return value;
}

/**
 * Декодирует закрытый процессный envelope; input остаётся ответственностью владельца действия.
 */
export function decodeGitSyncRequest(value: unknown): GitSyncRequest {
  const request = object(value);
  if (request.version !== 1) {
    throw new RelayError("GIT_SYNC_PROTOCOL_VERSION", messages.version, 2);
  }
  if (
    Object.keys(request).some((key) => !["version", "action", "options", "input"].includes(key))
  ) {
    throw new RelayError("GIT_SYNC_INVALID_REQUEST", messages.invalid, 2);
  }
  const options = object(request.options);
  if (Object.keys(options).some((key) => !["cwd", "config", "home", "project"].includes(key))) {
    throw new RelayError("GIT_SYNC_INVALID_REQUEST", messages.invalid, 2);
  }
  return {
    version: 1,
    action: text(request.action),
    options: {
      cwd: text(options.cwd),
      ...(options.config === undefined ? {} : { config: text(options.config) }),
      ...(options.home === undefined ? {} : { home: text(options.home) }),
      ...(options.project === undefined ? {} : { project: text(options.project) }),
    },
    ...(request.input === undefined ? {} : { input: object(request.input) }),
  };
}
