import {
  type RelayError,
  type PortableProjectSnapshot,
  type ReplicationChangeset,
  type ReplicationConflict,
} from "@relay/contracts";
import { replicationFingerprint } from "@relay/storage";

/**
 * Включает в просмотренный материал также явные no-op цели и прочитанные основания перехода.
 */
export function conflictOwnerIds(changeset: ReplicationChangeset): ReadonlySet<string> {
  return new Set([
    ...changeset.entities.map((entry) => entry.id),
    ...(changeset.components ?? []).map((part) => part.after.ownerId),
    ...changeset.readContext.map((entry) => entry.id),
    ...(changeset.transitions ?? []).flatMap((step) => step.targets?.ownerIds ?? []),
  ]);
}

/**
 * Связывает решение с точной удалённой областью и адресами; независимые тела других owners её не меняют.
 */
export function resolutionRemoteDigest(
  changeset: ReplicationChangeset,
  remote: PortableProjectSnapshot,
): string {
  const ids = conflictOwnerIds(changeset);
  const journals = new Set(changeset.comments.map((entry) => entry.taskId));
  const receipts = new Set(changeset.receipts.map((entry) => entry.operationKey));
  return replicationFingerprint({
    entities: remote.entities.filter((entry) => ids.has(entry.record.id)),
    components: (remote.components ?? []).filter((part) => ids.has(part.ownerId)),
    comments: remote.comments.filter((entry) => journals.has(entry.taskId)),
    receipts: remote.receipts.filter((entry) => receipts.has(entry.operationKey)),
    addresses: remote.addresses,
  });
}

/**
 * Связывает просмотренное решение с полными первичными сторонами, не включая local CAS.
 */
export function conflictFingerprint(
  changeset: ReplicationChangeset,
  local: PortableProjectSnapshot,
  remote: PortableProjectSnapshot,
): string {
  const ids = conflictOwnerIds(changeset);
  const journals = new Set(changeset.comments.map((entry) => entry.taskId));
  const receipts = new Set(changeset.receipts.map((entry) => entry.operationKey));
  return replicationFingerprint({
    changeset: changeset.id,
    local: local.entities
      .filter((entry) => ids.has(entry.record.id))
      .map((entry) => [entry.record.id, entry.version]),
    remote: remote.entities
      .filter((entry) => ids.has(entry.record.id))
      .map((entry) => [entry.record.id, entry.version]),
    localComponents: (local.components ?? []).filter((part) => ids.has(part.ownerId)),
    remoteComponents: (remote.components ?? []).filter((part) => ids.has(part.ownerId)),
    comments: remote.comments.filter((entry) => journals.has(entry.taskId)),
    localComments: local.comments.filter((entry) => journals.has(entry.taskId)),
    receipts: remote.receipts.filter((entry) => receipts.has(entry.operationKey)),
    addresses: remote.addresses,
  });
}

/**
 * Сохраняет все просмотренные sides атомарного конфликта, включая нормализованные части и журналы.
 */
export function createReplicationConflict(
  error: Pick<RelayError, "code" | "message">,
  changeset: ReplicationChangeset,
  local: PortableProjectSnapshot,
  remote: PortableProjectSnapshot,
): ReplicationConflict {
  const ids = conflictOwnerIds(changeset);
  const journals = new Set(changeset.comments.map((entry) => entry.taskId));
  const receiptKeys = new Set(changeset.receipts.map((entry) => entry.operationKey));
  const addresses = new Set(changeset.addresses.map((entry) => entry.ref));
  return {
    id: changeset.id,
    fingerprint: conflictFingerprint(changeset, local, remote),
    code: error.code,
    message: error.message,
    changeset,
    local: local.entities.filter((entry) => ids.has(entry.record.id)),
    remote: remote.entities.filter((entry) => ids.has(entry.record.id)),
    localComponents: (local.components ?? []).filter((part) => ids.has(part.ownerId)),
    remoteComponents: (remote.components ?? []).filter((part) => ids.has(part.ownerId)),
    localComments: local.comments.filter((entry) => journals.has(entry.taskId)),
    remoteComments: remote.comments.filter((entry) => journals.has(entry.taskId)),
    remoteReceipts: remote.receipts.filter((entry) => receiptKeys.has(entry.operationKey)),
    remoteAddresses: remote.addresses.filter(
      (entry) => ids.has(entry.entityId) || addresses.has(entry.ref),
    ),
  };
}
