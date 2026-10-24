import { RelayError } from "@relay/contracts";
import { appMessages } from "../app/app.messages";
import { requestObject, requiredString } from "../app/protocol";
import type { PublicationWindow } from "./state.types";

/**
 * Проверяет сохранённый неотрицательный cursor/счётчик; повреждение не превращается в начало очереди.
 */
function count(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new RelayError("GIT_SYNC_STATE_INVALID", appMessages.state, 4);
  }
  return value;
}

/**
 * Проверяет точные ID выбранного bounded окна без подстановки отсутствующих source.
 */
function sourceIds(value: unknown): readonly string[] {
  if (!Array.isArray(value)) {
    throw new RelayError("GIT_SYNC_STATE_INVALID", appMessages.state, 4);
  }
  return value.map(requiredString);
}

/**
 * Декодирует последнее окно; старые progress-файлы без этого поля имеют неизвестное окно.
 */
export function readPublicationWindow(value: unknown): PublicationWindow | null {
  if (value === undefined || value === null) {
    return null;
  }
  const item = requestObject(value);
  if (
    typeof item.hasMore !== "boolean" ||
    typeof item.oversized !== "boolean" ||
    typeof item.completed !== "boolean"
  ) {
    throw new RelayError("GIT_SYNC_STATE_INVALID", appMessages.state, 4);
  }
  return {
    afterSequence: count(item.afterSequence),
    nextSequence: count(item.nextSequence),
    hasMore: item.hasMore,
    examined: sourceIds(item.examined),
    included: sourceIds(item.included),
    deferred: sourceIds(item.deferred),
    sourceBytes: count(item.sourceBytes),
    oversized: item.oversized,
    completed: item.completed,
  };
}
