import { RelayError } from "@relay/contracts";

/**
 * Отклоняет async callback до каких-либо файловых операций; исполнение доверенного callback ещё не начинается.
 */
export function requireSynchronousRestorationCallback(
  callback: (path: string) => void,
  message: string,
): void {
  if (
    typeof callback !== "function" ||
    Object.prototype.toString.call(callback) === "[object AsyncFunction]"
  ) {
    throw new RelayError("INVALID_ARGUMENT", message, 2);
  }
}

/**
 * Выполняет доверенный синхронный callback; Promise/thenable/другой результат запрещает дальнейшую публикацию.
 * Не обещает откат собственного I/O callback: materializer пишет только staging, validator только читает.
 */
export function invokeRestorationCallback(
  callback: (path: string) => void,
  path: string,
  message: string,
): void {
  const returned: unknown = callback(path);
  if (returned !== undefined) {
    if (returned instanceof Promise) {
      void returned.catch(() => {});
    }
    throw new RelayError("INVALID_ARGUMENT", message, 2);
  }
}
