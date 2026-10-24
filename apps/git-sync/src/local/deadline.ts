import { RelayError } from "@relay/contracts";
import { transportMessages } from "../transport/transport.messages";

/**
 * Ожидает назначенный retry/deadline; отмена освобождает таймер и listener без лишнего запуска.
 */
export function waitUntil(deadline: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return Promise.reject(new RelayError("GIT_CANCELLED", transportMessages.aborted));
  }
  return new Promise((resolve, reject) => {
    /**
     * Завершает ожидание с освобождением внешнего listener.
     */
    function done(): void {
      signal.removeEventListener("abort", abort);
      resolve();
    }
    /**
     * Отменяет ещё не наступившую попытку.
     */
    function abort(): void {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      reject(new RelayError("GIT_CANCELLED", transportMessages.aborted));
    }
    const timer = setTimeout(done, Math.max(0, deadline - Date.now()));
    signal.addEventListener("abort", abort, { once: true });
  });
}
