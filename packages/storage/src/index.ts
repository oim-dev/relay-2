export { ProjectDatabase } from "./database/project-database";
export { withProjectDatabasePublication } from "./database/project-publication";
export type { ProjectMetadata } from "./database/project-database.types";
export { withLocalFileLock, acquireLocalLock } from "./local-lock/local-lock";
export type { LocalLock, LocalLockOptions } from "./local-lock/local-lock.types";
export type {
  EntityIdentityWithRevision,
  EntitySummaryProjection,
} from "./entities/entity-queries.types";
export type { StoredBatchReceipt } from "./batch/batch-receipt.types";
export type { ProjectStore, ReplicationStore } from "./database/project-store.types";
export type {
  ReplicationOutboxRequest,
  ReplicationOutboxWindow,
  ReplicationSourceDigest,
  ReplicationDependencySource,
} from "./replication/replication-outbox.types";
export type {
  ReplicationState,
  ReplicationStateUpdate,
  StoredReplicationDecision,
  ReplicationGuard,
  ReplicationImportPlan,
  PortableAggregateRoot,
  PortableAggregatePart,
  ResolutionLocalSource,
} from "./replication/replication.types";
export {
  canonicalJson,
  replicationFingerprint,
  portableEntity,
  portableAggregateVersion,
} from "./replication/portable-version";
export {
  readComponents,
  replaceComponents,
  synchronizeComponents,
  versionComponent,
} from "./components/component-store";
export { applyComponentImportDelta } from "./components/component-store";
export { adaptLegacyChangeset } from "./replication/replication-legacy";
export { planReplicationImport } from "./replication/replication-import-plan";
export type {
  SynchronizationSchedule,
  SynchronizationAttempt,
  SynchronizationMode,
} from "./synchronization/schedule.types";
export { snapshotToPortableRows, portableRowsToSnapshot } from "./relational/portable-codec";
export { RELATIONAL_TABLES } from "./relational/catalog";
export type { RelationalTableDescriptor } from "./relational/catalog.types";
export type {
  PortableTableRows,
  PortableTableMap,
  EntityRowMetadata,
  ComponentRowMetadata,
  EntityTableRow,
  ComponentTableRow,
  ImplementationTargetColumns,
  TaskTargetColumns,
  ObjectIdentityRow,
  CheckpointReferenceRow,
  CheckpointAcceptanceRow,
  PortableCommentRow,
  PortableEntityVersionRow,
  PortableReceiptRow,
  PortableConfirmationRow,
  PortablePublicationRow,
} from "./relational/rows.types";
