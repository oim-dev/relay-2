/**
 * Определяет async-функцию до вызова, чтобы она не запустила работу вне синхронной транзакции.
 */
export function isAsyncFunction(operation: () => unknown): boolean {
  return Object.prototype.toString.call(operation) === "[object AsyncFunction]";
}

/**
 * Распознаёт Promise и пользовательские thenable на границе синхронного callback.
 */
export function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  if (value === null || (typeof value !== "object" && typeof value !== "function")) {
    return false;
  }
  const then: unknown = Reflect.get(value, "then");
  return typeof then === "function";
}
