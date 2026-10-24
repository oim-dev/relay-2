import { GIT_SYNC_REQUEST_MAX_BYTES, RelayError, type GitSyncRequest } from "@relay/contracts";
import { gitSyncMessages as messages } from "./git-sync.messages";

/**
 * Формирует семантический отказ без сериализации самого неверного значения или выполнения toJSON.
 */
function invalidJson(path: readonly (string | number)[], reason: string): RelayError {
  return new RelayError("GIT_SYNC_INVALID_REQUEST", messages.invalidRequestJson, 2, {
    path: [...path],
    reason,
  });
}

/**
 * Проверяет один JSON-узел; active содержит только текущую цепочку, поэтому общие поддеревья допустимы.
 * Дескрипторы позволяют отклонить getters и игнорируемые stringify поля до их исполнения/потери.
 */
function checkJson(value: unknown, path: (string | number)[], active: WeakSet<object>): void {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw invalidJson(path, "non-finite-number");
    }
    return;
  }
  if (typeof value !== "object") {
    throw invalidJson(path, typeof value);
  }
  const array = Array.isArray(value);
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== null && prototype !== (array ? Array.prototype : Object.prototype)) {
    throw invalidJson(path, "non-json-object");
  }
  if (active.has(value)) {
    throw invalidJson(path, "cycle");
  }
  const keys = Reflect.ownKeys(value);
  if (array && keys.length !== value.length + 1) {
    throw invalidJson(path, "sparse-or-extended-array");
  }
  active.add(value);
  try {
    const entries = array ? Array.from({ length: value.length }, (_, index) => index) : keys;
    for (const key of entries) {
      if (typeof key === "symbol") {
        throw invalidJson(path, "symbol-key");
      }
      path.push(key);
      try {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
          throw invalidJson(path, "non-json-property");
        }
        checkJson(descriptor.value, path, active);
      } finally {
        path.pop();
      }
    }
  } finally {
    active.delete(value);
  }
}

/**
 * Требует конечные JSON-значения без undefined, cycles, getters, toJSON и потери свойств.
 * Не меняет исходный объект. Ошибки слишком глубокого/экзотического ввода возвращаются как отказ запроса.
 */
export function assertGitSyncJson(value: unknown): void {
  try {
    checkJson(value, [], new WeakSet());
  } catch (error) {
    if (error instanceof RelayError) {
      throw error;
    }
    const failure = invalidJson([], "unrepresentable-json");
    failure.cause = error;
    throw failure;
  }
}

/**
 * Проверяет семантику до JSON.stringify и размер полного UTF-8 envelope до любого spawn/открытия stdin.
 */
export function encodeGitSyncRequest(request: GitSyncRequest): string {
  assertGitSyncJson(request);
  let text: string;
  try {
    text = JSON.stringify(request);
  } catch (cause) {
    const failure = invalidJson([], "serialization-failed");
    failure.cause = cause;
    throw failure;
  }
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes > GIT_SYNC_REQUEST_MAX_BYTES) {
    throw new RelayError("GIT_SYNC_REQUEST_TOO_LARGE", messages.requestTooLarge, 2, {
      bytes,
      maxBytes: GIT_SYNC_REQUEST_MAX_BYTES,
    });
  }
  return text;
}
