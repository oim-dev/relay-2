import type { PortableProjectSnapshot, ReplicationHistoryInput } from "@relay/contracts";
import { decodeReplicationSnapshot } from "./snapshot-decoder";
import { validatePublicationChain } from "./publication";
import {
  rememberReplicationHistory,
  type ValidatedReplicationHistory,
} from "./replication-history-proof";
export { decodeReplicationSnapshot } from "./snapshot-decoder";

/**
 * Проверяет canonical ordered history до staging SQLite/ack и возвращает opaque Core capability.
 * base — принятый предок; null требует genesis. Игнорирование результата сохраняет прежний void-сценарий.
 */
export function validateReplicationHistory(
  base: PortableProjectSnapshot | null,
  remote: PortableProjectSnapshot,
  history: ReplicationHistoryInput = {},
): ValidatedReplicationHistory {
  const accepted = base === null ? null : decodeReplicationSnapshot(base);
  const target = decodeReplicationSnapshot(remote);
  const checked = validatePublicationChain(accepted, target, history);
  return rememberReplicationHistory(accepted, target, checked);
}
