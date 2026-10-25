import type { HttpGitSyncStatus } from "@relay/contracts";

/**
 * Выделяет сигнал инвалидирования чтения конфликтов из cached status.
 * Это локальный ключ кеша, не переносимая версия и не доказательство доставки.
 */
export function gitSyncDeliverySignal(status: HttpGitSyncStatus | undefined): string | null {
  if (status === undefined) {
    return null;
  }
  return JSON.stringify([
    status.connected,
    status.pending.changesets,
    status.pending.unexported,
    status.conflicts.count,
    status.conflicts.freshness,
    status.conflicts.asOf,
    status.lastSuccess,
    status.freshness.known,
    status.freshness.asOf,
    status.freshness.remoteHead,
    status.error?.code,
    status.error?.message,
  ]);
}
