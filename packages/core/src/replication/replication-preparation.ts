import {
  RelayError,
  type PortableProjectSnapshot,
  type ReplicationChangeset,
  type ReplicationConflict,
  type PublicationChange,
  type ReplicationResolution,
} from "@relay/contracts";
import { portableEntity, type StoredReplicationDecision } from "@relay/storage";
import { isConfirmed } from "./confirmations";
import {
  availableProvisionalKey,
  canonicalSnapshot,
  reconcileAddressComponents,
} from "./snapshot-merge";
import { replicationMessages } from "./replication.messages";
import { applyPublicationChange } from "./publication-effects";
import { publishChanges } from "./publication";
import { createReplicationConflict } from "./conflict-material";
import { confirmedResolution, isResolutionAdoption } from "./resolution-acceptance";
import { decisionApplies } from "./resolution-application";
import { validateResolution } from "./resolution-validation";
import type {
  PendingReplicationPreparation,
  ReplicationDependencyWait,
} from "./replication-selection.types";
import { dependencyWait } from "./replication-dependencies";

/**
 * Готовит доставляемую часть очереди без сети и без изменения переданных снимков.
 * Учитывает сохранённые зависимости чтений и записей; независимые changeset обходят конфликт.
 */
export function prepareReplication(
  local: PortableProjectSnapshot,
  remote: PortableProjectSnapshot,
  outbox: readonly ReplicationChangeset[],
  decisions: readonly StoredReplicationDecision[],
  generation: number,
  decisionOutbox: readonly ReplicationChangeset[] = outbox,
): PendingReplicationPreparation {
  let snapshot = remote;
  const conflicts: ReplicationConflict[] = [];
  const included: string[] = [];
  const published: PublicationChange[] = [];
  const deferred: ReplicationChangeset[] = [];
  const waiting: ReplicationDependencyWait[] = [];
  const choices = new Map(decisions.map((entry) => [entry.id, entry]));
  for (const change of outbox) {
    if (isConfirmed(remote.confirmations, change.id)) {
      const decision = choices.get(change.id);
      const accepted = confirmedResolution(remote, change.id);
      if (
        decision !== undefined &&
        decision.resolutionId !== accepted &&
        !isResolutionAdoption(decision, accepted)
      ) {
        const pendingResolution = portableResolution(decision);
        conflicts.push({
          ...createReplicationConflict(
            new RelayError("REPLICATION_RESOLUTION_STALE", replicationMessages.resolutionStale, 4),
            change,
            local,
            remote,
          ),
          pendingResolution,
          acceptedResolutionId: accepted,
        });
      }
      continue;
    }
    const blocked = dependencyWait(change, snapshot.confirmations);
    if (blocked !== null) {
      deferred.push(change);
      waiting.push(blocked);
      continue;
    }
    try {
      const decision = choices.get(change.id);
      const resolution =
        decision !== undefined &&
        decisionApplies(change, local, remote, decisionOutbox, decisions, decision)
          ? decision
          : null;
      const portable = resolution === null ? null : portableResolution(resolution);
      if (portable !== null) {
        validateResolution(portable, change, remote);
      }
      const applied = applyPublicationChange(snapshot, change, portable);
      snapshot = applied.snapshot;
      published.push(applied.change);
      included.push(change.id);
    } catch (error) {
      if (!(error instanceof RelayError)) {
        throw error;
      }
      conflicts.push(createReplicationConflict(error, change, local, remote));
    }
  }
  return {
    snapshot: publishChanges(remote, canonicalSnapshot(snapshot), published),
    generation,
    included,
    conflicts,
    deferred,
    waiting,
  };
}

/**
 * Исключает локальный SQL lookup id, сохраняя весь переносимый immutable материал решения.
 */
function portableResolution(stored: StoredReplicationDecision): ReplicationResolution {
  const { id: _id, localSources: _localSources, ...resolution } = stored;
  return resolution;
}

/**
 * Сохраняет локальную сторону конфликтных и ожидающих зависимости владельцев поверх снимка.
 * Общая проверка после этого шага может отложить импорт, но не уничтожить локальные записи.
 */
export function retainConflictedLocal(
  prepared: PendingReplicationPreparation,
  local: PortableProjectSnapshot,
): PortableProjectSnapshot {
  const retained = [...prepared.conflicts.map((entry) => entry.changeset), ...prepared.deferred];
  if (retained.length === 0) {
    return prepared.snapshot;
  }
  const owners = new Set(
    retained.flatMap((change) => [
      ...change.entities.map((entry) => entry.id),
      ...(change.components ?? []).map((part) => part.after.ownerId),
    ]),
  );
  const records = new Map(prepared.snapshot.entities.map((entry) => [entry.record.id, entry]));
  const addresses = new Map(
    prepared.snapshot.addresses
      .filter((entry) => !owners.has(entry.entityId))
      .map((entry) => [entry.ref, entry.entityId]),
  );
  for (const entry of local.entities) {
    if (!owners.has(entry.record.id)) {
      continue;
    }
    let retained = entry;
    const owner = addresses.get(entry.record.key);
    if (owner !== undefined && owner !== entry.record.id) {
      retained = portableEntity(
        { ...entry.record, key: availableProvisionalKey(entry.record.key, addresses) },
        [entry.version],
      );
    }
    records.set(entry.record.id, retained);
    addresses.set(retained.record.key, retained.record.id);
    addresses.set(retained.record.id, retained.record.id);
  }
  for (const entry of local.addresses) {
    if (owners.has(entry.entityId) && !addresses.has(entry.ref)) {
      addresses.set(entry.ref, entry.entityId);
    }
  }
  const comments = new Map(prepared.snapshot.comments.map((entry) => [entry.comment.id, entry]));
  const receipts = new Map(prepared.snapshot.receipts.map((entry) => [entry.operationKey, entry]));
  const pendingComments = new Set(
    retained.flatMap((change) => change.comments.map((entry) => entry.comment.id)),
  );
  for (const entry of local.comments) {
    if (owners.has(entry.taskId) || pendingComments.has(entry.comment.id)) {
      comments.set(entry.comment.id, entry);
    }
  }
  for (const change of retained) {
    for (const receipt of change.receipts) {
      receipts.set(receipt.operationKey, receipt);
    }
  }
  return canonicalSnapshot({
    ...prepared.snapshot,
    entities: [...records.values()],
    components: reconcileAddressComponents(
      [
        ...(prepared.snapshot.components ?? []).filter((part) => !owners.has(part.ownerId)),
        ...(local.components ?? []).filter((part) => owners.has(part.ownerId)),
      ],
      records,
      addresses,
    ),
    addresses: [...addresses].map(([ref, entityId]) => ({ ref, entityId })),
    comments: [...comments.values()],
    receipts: [...receipts.values()],
  });
}
