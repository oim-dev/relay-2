import { RelayError } from "@relay/contracts";
import type { ServerRegistration } from "@relay/project-runtime";
import type { StartedRelayServer } from "../server.types";
import { processMessages } from "./process.messages";
import type { ShutdownClock } from "./shutdown.types";

/**
 * Время на добровольное завершение собственных Runtime requests перед отменой их process trees.
 */
export const REQUEST_GRACE_MS = 8_000;
/**
 * Общий предел process shutdown; превышение не освобождает lease до завершения самого процесса.
 */
export const SHUTDOWN_DEADLINE_MS = 12_000;

const realClock: ShutdownClock = {
  /**
   * Создаёт реальный таймер и возвращает освобождение его ресурса при любом исходе shutdown.
   */
  schedule: (delayMs, callback): (() => void) => {
    const timer = setTimeout(callback, delayMs);
    return () => clearTimeout(timer);
  },
};

/**
 * Снимает readiness перед drain. После grace отменяет только собственные Runtime процессы.
 * Lease освобождается после HTTP/SSE/writers; при timeout остаётся до выхода ОС/guardian.
 */
export async function shutdown(
  server: Pick<StartedRelayServer, "close">,
  registration: Pick<ServerRegistration, "draining" | "close">,
  requests: AbortController,
  clock: ShutdownClock = realClock,
): Promise<void> {
  registration.draining();
  const cancelGrace = clock.schedule(REQUEST_GRACE_MS, () => requests.abort("SIGTERM"));
  /**
   * После создания timeout освобождает его таймер при любом исходе Promise.race.
   */
  let cancelDeadline = (): void => {};
  const timeout = new Promise<never>((_resolve, reject) => {
    cancelDeadline = clock.schedule(SHUTDOWN_DEADLINE_MS, () =>
      reject(
        new RelayError("SERVER_SHUTDOWN_TIMEOUT", processMessages.timeout, 124, {
          timeoutMs: SHUTDOWN_DEADLINE_MS,
        }),
      ),
    );
  });
  try {
    await Promise.race([server.close(), timeout]);
    registration.close();
  } finally {
    cancelGrace();
    cancelDeadline();
  }
}
