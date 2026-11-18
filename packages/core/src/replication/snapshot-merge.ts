import {
  RelayError,
  type PortableAddress,
  type PortableEntity,
  type PortableProjectSnapshot,
  type ReplicationChangeset,
  type ReplicationTransition,
} from "@relay/contracts";
import { canonicalJson, portableEntity } from "@relay/storage";
import { confirmChangeset } from "./confirmations";
import { mergeRecord } from "./record-merge";
import { replicationMessages } from "./replication.messages";
import { validateSnapshot } from "./snapshot-validation";
import { validateChangesetTransition } from "./transition-validation";
import { validateAcceptedHistory } from "./history-continuity";
import { mergeComponents } from "./component-merge";
import { canonicalSnapshot } from "./snapshot-canonical";
import { logicalTransitionChangeset } from "./transition-records";
import type { ReplicationRecordOverride } from "./replication-resolution.types";
export { canonicalSnapshot } from "./snapshot-canonical";

/**
 * Согласует новые адреса; коллизия текущего ключа требует отдельного явного выбора.
 * Подтверждённое назначение, ID и содержание сохраняются; проигранный ключ не становится alias.
 */
function mergeAddresses(
  changeset: ReplicationChangeset,
  records: Map<string, PortableEntity>,
  addresses: Map<string, string>,
): void {
  for (const entry of changeset.addresses) {
    const owner = addresses.get(entry.ref);
    if (owner !== undefined && owner !== entry.entityId) {
      const record = records.get(entry.entityId);
      if (record === undefined || entry.ref === entry.entityId || record.record.key !== entry.ref) {
        throw new RelayError("REPLICATION_ADDRESS", replicationMessages.address, 4, {
          ref: entry.ref,
        });
      }
      throw new RelayError("REPLICATION_KEY_COLLISION", replicationMessages.keyCollision, 4, {
        ref: entry.ref,
        entityId: entry.entityId,
        acceptedOwnerId: owner,
      });
    }
    addresses.set(entry.ref, entry.entityId);
  }
  for (const change of changeset.entities) {
    const record = records.get(change.id);
    if (record !== undefined) {
      const owner = addresses.get(record.record.key);
      if (owner !== undefined && owner !== change.id) {
        throw new RelayError("REPLICATION_ADDRESS", replicationMessages.address, 4);
      }
      addresses.set(record.record.key, change.id);
      addresses.set(change.id, change.id);
    }
  }
}

/**
 * Добавляет неизменяемые объекты по ID; повтор принимается только при точном совпадении.
 */
function immutableUnion<T>(
  existing: readonly T[],
  incoming: readonly T[],
  identify: (entry: T) => string,
): T[] {
  const result = new Map(existing.map((entry) => [identify(entry), entry]));
  for (const entry of incoming) {
    const id = identify(entry);
    const previous = result.get(id);
    if (previous !== undefined && canonicalJson(previous) !== canonicalJson(entry)) {
      throw new RelayError("REPLICATION_IMMUTABLE", replicationMessages.immutable, 4, { id });
    }
    result.set(id, entry);
  }
  return [...result.values()];
}

/**
 * Применяет целый changeset в памяти, затем проверяет состояние и переходы одним графом.
 * При отказе исходный снимок не меняется; явный remote отклоняет предметную часть целиком.
 */
export function applyChangeset(
  previous: PortableProjectSnapshot,
  changeset: ReplicationChangeset,
  choice?: "local" | "remote",
  transition?: ReplicationTransition,
  overrides?: ReadonlyMap<string, ReplicationRecordOverride>,
): PortableProjectSnapshot {
  const receipts = immutableUnion(
    previous.receipts,
    changeset.receipts,
    (entry) => entry.operationKey,
  );
  const confirmations = confirmChangeset(
    previous.confirmations,
    changeset.replicaId,
    changeset.sequence,
    changeset.digest,
  );
  const comments = immutableUnion(
    previous.comments,
    changeset.comments,
    (entry) => entry.comment.id,
  );
  if (choice === "remote") {
    if (previous.entities.length === 0) {
      throw new RelayError("REPLICATION_INVARIANT", replicationMessages.invariant, 4);
    }
    return canonicalSnapshot({ ...previous, receipts, confirmations });
  }
  const records = new Map(previous.entities.map((entry) => [entry.record.id, entry]));
  for (const change of changeset.entities) {
    const current = records.get(change.id) ?? null;
    let merged = mergeRecord(
      change.before,
      change.after,
      current,
      choice === "local",
      overrides?.get(change.id),
    );
    if (
      changeset.modelVersion !== 2 &&
      merged !== null &&
      current !== null &&
      merged.version !== current.version &&
      !(merged.parents ?? []).includes(current.version)
    ) {
      merged = portableEntity(merged.record, [merged.version, current.version]);
    }
    if (merged === null) {
      records.delete(change.id);
    } else {
      records.set(change.id, merged);
    }
  }
  const addresses = new Map(previous.addresses.map((entry) => [entry.ref, entry.entityId]));
  mergeAddresses(changeset, records, addresses);
  const next = canonicalSnapshot({
    ...previous,
    entities: [...records.values()],
    components: mergeComponents(
      previous.components ?? [],
      changeset.components ?? [],
      choice === "local",
    ),
    addresses: [...addresses].map(([ref, entityId]): PortableAddress => ({ ref, entityId })),
    comments,
    receipts,
    confirmations,
  });
  const index = validateSnapshot(next);
  if (changeset.mode !== "baseline" || previous.entities.length > 0) {
    validateChangesetTransition(
      logicalTransitionChangeset(changeset, previous, next),
      previous,
      index,
      transition,
    );
  }
  return next;
}

/**
 * Проверяет, что новый remote сохраняет уже опубликованные назначения и неизменяемую историю.
 * Это проверка монотонной истории состояния, а не повторное исполнение старых переходов.
 */
export function validateAcceptedEvolution(
  base: PortableProjectSnapshot | null,
  remote: PortableProjectSnapshot,
): void {
  if (base === null) {
    return;
  }
  const parts = new Map(
    (remote.components ?? []).map((entry) => [
      JSON.stringify([entry.ownerId, entry.kind, entry.id]),
      entry,
    ]),
  );
  for (const part of base.components ?? []) {
    const next = parts.get(JSON.stringify([part.ownerId, part.kind, part.id]));
    if (next === undefined || (part.deleted && !next.deleted && part.kind !== "collection")) {
      throw new RelayError("REPLICATION_REGRESSION", replicationMessages.regression, 4, {
        componentId: part.id,
      });
    }
  }
  validateAcceptedHistory(base, remote);
  const addresses = new Map(remote.addresses.map((entry) => [entry.ref, entry.entityId]));
  const records = new Map(remote.entities.map((entry) => [entry.record.id, entry]));
  for (const entry of base.addresses) {
    if (addresses.get(entry.ref) !== entry.entityId) {
      throw new RelayError("REPLICATION_ADDRESS", replicationMessages.address, 4);
    }
  }
  immutableUnion(remote.comments, base.comments, (entry) => entry.comment.id);
  immutableUnion(remote.receipts, base.receipts, (entry) => entry.operationKey);
  if (
    base.comments.some(
      (entry) => !remote.comments.some((next) => next.comment.id === entry.comment.id),
    ) ||
    base.receipts.some(
      (entry) => !remote.receipts.some((next) => next.operationKey === entry.operationKey),
    )
  ) {
    throw new RelayError("REPLICATION_REGRESSION", replicationMessages.regression, 4);
  }
  for (const entry of base.entities) {
    const next = records.get(entry.record.id);
    if (
      next === undefined ||
      next.record.kind !== entry.record.kind ||
      next.record.createdAt !== entry.record.createdAt ||
      next.record.createdBy !== entry.record.createdBy
    ) {
      throw new RelayError("REPLICATION_IMMUTABLE", replicationMessages.immutable, 4);
    }
    const frozen =
      entry.record.kind === "work-checkpoint" ||
      (entry.record.kind === "work-plan" &&
        ["completed", "cancelled"].includes(String(entry.record.data.status))) ||
      (entry.record.kind === "work-session" &&
        ["completed", "cancelled"].includes(String(entry.record.data.status))) ||
      (entry.record.kind === "release" && entry.record.data.status === "released");
    if (frozen && entry.version !== next.version) {
      throw new RelayError("REPLICATION_IMMUTABLE", replicationMessages.immutable, 4);
    }
  }
}
