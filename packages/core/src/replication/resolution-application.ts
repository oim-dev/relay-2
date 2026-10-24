import type { PortableProjectSnapshot, ReplicationChangeset } from "@relay/contracts";
import {
  canonicalJson,
  type ResolutionLocalSource,
  type StoredReplicationDecision,
} from "@relay/storage";
import { conflictFingerprint, conflictOwnerIds, resolutionRemoteDigest } from "./conflict-material";
import { isConfirmed } from "./confirmations";

/**
 * Фиксирует только pending effects, меняющие просмотренные owners/journals, и их явные решения.
 * Receipt-only и независимые записи не создают искусственную глобальную зависимость.
 */
export function resolutionLocalSources(
  source: ReplicationChangeset,
  outbox: readonly ReplicationChangeset[],
  remote: PortableProjectSnapshot,
  decisions: readonly StoredReplicationDecision[],
): ResolutionLocalSource[] {
  const owners = conflictOwnerIds(source);
  const journals = new Set(source.comments.map((entry) => entry.taskId));
  const choices = new Map(decisions.map((entry) => [entry.id, entry.resolutionId]));
  return outbox
    .filter(
      (entry) =>
        !isConfirmed(remote.confirmations, entry.id) &&
        (entry.entities.some((change) => owners.has(change.id)) ||
          (entry.components ?? []).some((part) => owners.has(part.after.ownerId)) ||
          entry.comments.some((comment) => journals.has(comment.taskId))),
    )
    .map((entry) => ({
      id: entry.id,
      digest: entry.digest,
      resolutionId: choices.get(entry.id) ?? null,
    }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/**
 * Принимает прежнее решение после собственного deterministic import, но не после нового scoped write.
 * Исходный fingerprint/material не переписываются: derived portable versions не равны пользовательской правке.
 */
export function decisionApplies(
  source: ReplicationChangeset,
  local: PortableProjectSnapshot,
  remote: PortableProjectSnapshot,
  outbox: readonly ReplicationChangeset[],
  decisions: readonly StoredReplicationDecision[],
  decision: StoredReplicationDecision,
): boolean {
  if (
    decision.formatVersion !== 1 ||
    decision.remoteDigest !== resolutionRemoteDigest(source, remote)
  ) {
    return false;
  }
  if (decision.fingerprint === conflictFingerprint(source, local, remote)) {
    return true;
  }
  if (decision.localSources === undefined) {
    return false;
  }
  const initial = decision.localSources.filter(
    (entry) => !isConfirmed(remote.confirmations, entry.id),
  );
  return (
    canonicalJson(initial) ===
    canonicalJson(resolutionLocalSources(source, outbox, remote, decisions))
  );
}
