import type { PortableProjectSnapshot } from "@relay/contracts";
import {
  replicationFingerprint,
  type ReplicationGuard,
  type ReplicationStore,
} from "@relay/storage";
import type { CachedReplicationSnapshot } from "./replication-context.types";

const localSnapshots = new WeakMap<ReplicationStore, CachedReplicationSnapshot>();

/**
 * Читает локальный checkpoint только при exact guard; любой поздний write/receipt/решение делает miss.
 */
export function cachedLocalSnapshot(
  store: ReplicationStore,
  guard: ReplicationGuard,
): PortableProjectSnapshot | undefined {
  const known = localSnapshots.get(store);
  return known?.guard === replicationFingerprint(guard) ? known.snapshot : undefined;
}

/**
 * Запоминает fully imported immutable target и guard из той же transaction, до открытия окна для writer.
 * Вызывающий передаёт frozen Core snapshot и гарантирует отсутствие оставшихся pending effects.
 */
export function rememberLocalSnapshot(
  store: ReplicationStore,
  snapshot: PortableProjectSnapshot,
  guard: ReplicationGuard,
): void {
  localSnapshots.set(store, {
    guard: replicationFingerprint(guard),
    snapshot: Object.freeze({ ...snapshot, publication: null }),
  });
}
