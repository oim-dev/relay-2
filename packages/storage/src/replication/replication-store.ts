import type { Database } from "bun:sqlite";
import {
  RelayError,
  type PortableAddress,
  type PortableBatchReceipt,
  type PortableComment,
  type PortableProjectSnapshot,
  type ReplicationChangeset,
  type ReplicationConflict,
  type ReplicationStatus,
  type ReplicationReadGuard,
} from "@relay/contracts";
import { storageReplicationMessages } from "./replication.messages";
import { canonicalJson, portableEntity, replicationFingerprint } from "./portable-version";
import { readComponents, flushComponentVersions } from "../components/component-store";
import { TASK_COMMENT_JSON, TASK_COMMENT_SOURCE } from "../entities/comment-text";
import { readComponentChanges, readTransitionQueue } from "./replication-transitions";
import { decodeOutboxChangeset } from "./replication-outbox";
import type {
  EntityDeltaRow,
  ReplicationJsonRow,
  ReplicationState,
  ReplicationStateRow,
  ReplicationStateUpdate,
  StoredReplicationDecision,
  StoredEntityVersion,
  ReplicationCursorRow,
  ReplicationGuard,
} from "./replication.types";

const COMMENTS = `SELECT json_object('taskId',c.task_id,'after',o.after_id,'comment',${TASK_COMMENT_JSON}) AS json
  FROM ${TASK_COMMENT_SOURCE} JOIN replication_comment_order o ON o.id=c.id`;
const RECEIPTS = `SELECT operation_key AS operationKey,request_json AS requestJson,result_json AS resultJson FROM batch_receipts`;
const RECORDS = `SELECT json_object('id',entities.id,'kind',kind,'key',key,'revision',revision,
  'createdAt',created_at,'updatedAt',updated_at,'createdBy',created_by,'updatedBy',updated_by,'data',json(data)) AS json,
  v.version,v.parents_json,q.id AS pending_id FROM entities
  LEFT JOIN replication_entity_versions v ON v.entity_id=entities.id
  LEFT JOIN replication_entity_queue q ON q.id=entities.id`;

/**
 * Читает локальное состояние реплики в снимке вызывающего; база JSON создана проверенным Core.
 */
export function readReplicationState(connection: Database): ReplicationState {
  const row = connection
    .query<ReplicationStateRow, []>("SELECT * FROM replication_state WHERE singleton=1")
    .get();
  if (row === null) {
    throw new RelayError("DATABASE_INVALID", storageReplicationMessages.stateMissing, 1);
  }
  const base = row.base_json === null ? null : JSON.parse(row.base_json);
  return {
    replicaId: row.replica_id,
    sequence: row.sequence,
    revision: row.revision,
    base,
    observed:
      row.observed_json === row.base_json
        ? base
        : row.observed_json === null
          ? null
          : JSON.parse(row.observed_json),
  };
}

/**
 * Читает полный переносимый снимок только при явном обмене, никогда на обычной записи.
 */
export function captureStoredProject(
  connection: Database,
  projectId: string,
): PortableProjectSnapshot {
  const accepted = connection
    .query<{ json: string | null }, []>(
      "SELECT json_extract(base_json,'$.confirmations') AS json FROM replication_state WHERE singleton=1",
    )
    .get();
  if (accepted === null) {
    throw new RelayError("DATABASE_INVALID", storageReplicationMessages.stateMissing, 1);
  }
  return {
    formatVersion: 1,
    modelVersion: 2,
    projectId,
    components: readComponents(connection),
    publication: null,
    entities: connection
      .query<ReplicationJsonRow & Partial<StoredEntityVersion> & { pending_id: string | null }, []>(
        `${RECORDS} ORDER BY entities.id`,
      )
      .all()
      .map((row) => {
        const record = JSON.parse(row.json);
        const stored = portableEntity(
          record,
          row.parents_json == null ? [] : JSON.parse(row.parents_json),
        );
        if (row.pending_id === null && row.version !== stored.version) {
          throw new RelayError("CORRUPT_DATA", storageReplicationMessages.corruptVersion, 1, {
            id: stored.record.id,
          });
        }
        return row.version == null || row.version === stored.version
          ? stored
          : portableEntity(record, [row.version]);
      }),
    addresses: connection
      .query<PortableAddress, []>("SELECT ref,entity_id AS entityId FROM entity_refs ORDER BY ref")
      .all(),
    comments: connection
      .query<ReplicationJsonRow, []>(`${COMMENTS} ORDER BY c.id`)
      .all()
      .map((row) => JSON.parse(row.json)),
    receipts: connection
      .query<PortableBatchReceipt, []>(`${RECEIPTS} ORDER BY operation_key`)
      .all(),
    confirmations: accepted?.json == null ? [] : JSON.parse(accepted.json),
  };
}

/**
 * Схлопывает лишь SQL-дельты текущей outer transaction в одну durable-запись.
 * Savepoint и dryrun откатывают SQL-очереди; отсутствие дельт не расходует sequence.
 */
export function flushReplicationQueue(connection: Database, baseline = false): void {
  flushComponentVersions(connection);
  const components = readComponentChanges(connection);
  const transitions = readTransitionQueue(connection);
  const storedReadContext = connection
    .query<ReplicationReadGuard, []>(
      "SELECT entity_id AS id,record_kind AS kind,version,changeset_id AS sourceChangesetId FROM replication_read_queue ORDER BY owner",
    )
    .all();
  const readContext = [
    ...new Map(
      [...storedReadContext, ...transitions.flatMap((step) => step.readContext)].map((entry) => [
        `${entry.kind}:${entry.id}:${entry.sourceChangesetId}`,
        entry,
      ]),
    ).values(),
  ];
  const rows = connection
    .query<EntityDeltaRow, []>("SELECT * FROM replication_entity_queue ORDER BY id")
    .all();
  const addresses = connection
    .query<PortableAddress, []>(
      "SELECT ref,entity_id AS entityId FROM replication_address_queue ORDER BY ref",
    )
    .all();
  const pendingComments = connection
    .query<{ id: string }, []>("SELECT id FROM replication_comment_queue")
    .all();
  const comments: PortableComment[] =
    pendingComments.length === 0
      ? []
      : connection
          .query<ReplicationJsonRow, []>(
            `${COMMENTS} JOIN replication_comment_queue q ON q.id=c.id ORDER BY c.id`,
          )
          .all()
          .map((row) => JSON.parse(row.json));
  const receipts = connection
    .query<PortableBatchReceipt, []>(
      `${RECEIPTS} WHERE operation_key IN (SELECT operation_key FROM replication_receipt_queue) ORDER BY operation_key`,
    )
    .all();
  if (
    rows.length + components.length + addresses.length + comments.length + receipts.length ===
    0
  ) {
    if (readContext.length > 0) {
      connection.exec("DELETE FROM replication_read_queue");
    }
    if (transitions.length > 0) {
      connection.exec(
        "DELETE FROM replication_transition_queue; DELETE FROM replication_transition_heads; UPDATE replication_transition_cursor SET component_sequence=0 WHERE singleton=1 AND component_sequence!=0",
      );
    }
    return;
  }
  const state = connection
    .query<ReplicationCursorRow, []>(
      "SELECT replica_id,sequence,project_id FROM replication_state JOIN project_state USING(singleton) WHERE singleton=1",
    )
    .get();
  if (state === null) {
    throw new RelayError("DATABASE_INVALID", storageReplicationMessages.stateMissing, 1);
  }
  const sequence = state.sequence + 1;
  const id = `${state.replica_id}:${sequence}`;
  const owners = [
    ...new Set([
      ...rows.map((row) => `entity:${row.id}`),
      ...components.map((part) => `component:${part.key}`),
      ...rows.filter((row) => row.before_json === null).map((row) => `existence:${row.id}`),
      ...addresses.map((address) => `entity:${address.entityId}`),
      ...comments.map((entry) => `comments:${entry.taskId}`),
      ...receipts.map((receipt) => `receipt:${receipt.operationKey}`),
    ]),
  ];
  const ownerDependencies = connection
    .query<{ changeset_id: string }, [string]>(
      "SELECT DISTINCT changeset_id FROM replication_owner_heads WHERE owner IN (SELECT value FROM json_each(?)) ORDER BY changeset_id",
    )
    .all(JSON.stringify([...owners, ...comments.map((entry) => `existence:${entry.taskId}`)]))
    .map((row) => row.changeset_id);
  const dependencies = [
    ...new Set([
      ...ownerDependencies,
      ...readContext.flatMap((entry) =>
        entry.sourceChangesetId === null ? [] : [entry.sourceChangesetId],
      ),
    ]),
  ].sort();
  const finalTransitions = new Map(
    transitions.flatMap((step) => step.entities).map((entry) => [entry.id, entry]),
  );
  const entities = rows.map((row) => {
    const stored = connection
      .query<StoredEntityVersion, [string]>(
        "SELECT version,parents_json FROM replication_entity_versions WHERE entity_id=?",
      )
      .get(row.id);
    const before =
      row.before_json === null
        ? null
        : portableEntity(
            JSON.parse(row.before_json),
            stored === null ? [] : JSON.parse(stored.parents_json),
          );
    const lastTransition = finalTransitions.get(row.id);
    const after =
      lastTransition?.after ??
      (row.after_json === null
        ? null
        : portableEntity(JSON.parse(row.after_json), before === null ? [] : [before.version]));
    if (after !== null) {
      connection
        .query(
          "INSERT INTO replication_entity_versions VALUES(?,?,?) ON CONFLICT(entity_id) DO UPDATE SET version=excluded.version,parents_json=excluded.parents_json",
        )
        .run(row.id, after.version, JSON.stringify(after.parents));
    }
    return { id: row.id, before, after };
  });
  const payload: Omit<ReplicationChangeset, "digest"> = {
    formatVersion: 1,
    modelVersion: 2,
    projectId: state.project_id,
    mode: baseline ? "baseline" : "mutation",
    id,
    replicaId: state.replica_id,
    sequence,
    createdAt: new Date().toISOString(),
    dependencies,
    readContext,
    components,
    transitions:
      transitions.length > 0
        ? transitions
        : [
            {
              command: baseline ? "baseline" : "storage.atomic",
              actor:
                entities.find((entry) => entry.after !== null)?.after?.record.updatedBy ??
                comments[0]?.comment.createdBy ??
                "relay:storage",
              entities,
              components,
              addresses,
              comments,
              receipts,
              readContext,
              predicates: [],
            },
          ],
    entities,
    addresses,
    comments,
    receipts,
  };
  const changeset: ReplicationChangeset = { ...payload, digest: replicationFingerprint(payload) };
  connection
    .query("INSERT INTO replication_outbox VALUES(?,?,?)")
    .run(id, sequence, JSON.stringify(changeset));
  connection
    .query("UPDATE replication_state SET sequence=?,revision=revision+1 WHERE singleton=1")
    .run(sequence);
  const head = connection.query(
    "INSERT INTO replication_owner_heads VALUES(?,?) ON CONFLICT(owner) DO UPDATE SET changeset_id=excluded.changeset_id",
  );
  for (const owner of owners) {
    head.run(owner, id);
  }
  connection.exec(
    "DELETE FROM replication_entity_queue; DELETE FROM replication_address_queue; DELETE FROM replication_comment_queue; DELETE FROM replication_receipt_queue; DELETE FROM replication_read_queue; DELETE FROM component_changes; DELETE FROM component_events; DELETE FROM replication_transition_queue; DELETE FROM replication_transition_heads; UPDATE replication_transition_cursor SET component_sequence=0 WHERE singleton=1;",
  );
}

/**
 * Явно читает и проверяет всю очередь для полного local overlay, а не выбора публикации.
 */
export function readOutbox(connection: Database): ReplicationChangeset[] {
  return connection
    .query<ReplicationJsonRow, []>("SELECT json FROM replication_outbox ORDER BY sequence")
    .all()
    .map(decodeOutboxChangeset);
}

/**
 * Читает сохранённые материалы выбранных ID либо всех конфликтов при отсутствии фильтра.
 */
export function readReplicationConflicts(
  connection: Database,
  ids?: readonly string[],
): ReplicationConflict[] {
  return connection
    .query<ReplicationJsonRow, [string | null]>(
      "SELECT json FROM replication_conflicts WHERE ?1 IS NULL OR id IN (SELECT value FROM json_each(?1)) ORDER BY id",
    )
    .all(ids === undefined ? null : JSON.stringify(ids))
    .map((row) => JSON.parse(row.json));
}

/**
 * Читает решения для ещё ожидающих changeset; подтверждённые решения остаются локальным аудитом.
 * Необязательный набор ID ограничивает payload решения выбранным окном; fingerprint проверяет Core.
 */
export function readReplicationDecisions(
  connection: Database,
  ids?: readonly string[],
): StoredReplicationDecision[] {
  return connection
    .query<ReplicationJsonRow, [string | null]>(
      "SELECT d.json FROM replication_resolutions d JOIN replication_outbox o ON o.id=d.changeset_id WHERE (?1 IS NULL OR d.changeset_id IN (SELECT value FROM json_each(?1))) AND NOT EXISTS(SELECT 1 FROM replication_resolutions newer WHERE newer.changeset_id=d.changeset_id AND newer.rowid>d.rowid) ORDER BY d.changeset_id",
    )
    .all(ids === undefined ? null : JSON.stringify(ids))
    .map((row) => JSON.parse(row.json));
}

/**
 * Сохраняет техническое состояние в транзакции вызывающего, не создавая echo-outbox.
 * Список acknowledged формирует Core только из подтверждений реально принятого remote.
 */
export function writeReplicationState(connection: Database, update: ReplicationStateUpdate): void {
  const before = connection
    .query<Pick<ReplicationStateRow, "base_json" | "observed_json">, []>(
      "SELECT base_json,observed_json FROM replication_state WHERE singleton=1",
    )
    .get();
  let changed = false;
  if (update.base !== undefined) {
    const json = canonicalJson(update.base);
    if (before?.base_json !== json) {
      changed = true;
      connection.query("UPDATE replication_state SET base_json=? WHERE singleton=1").run(json);
    }
  }
  if (update.observed !== undefined) {
    const json = update.observed === null ? null : canonicalJson(update.observed);
    if (before?.observed_json !== json) {
      changed = true;
      connection.query("UPDATE replication_state SET observed_json=? WHERE singleton=1").run(json);
    }
  }
  const previousConflicts = readReplicationConflicts(connection, update.examined);
  const conflictsChanged =
    replicationFingerprint(previousConflicts) !==
    replicationFingerprint([...update.conflicts].sort((a, b) => (a.id < b.id ? -1 : 1)));
  if (conflictsChanged) {
    changed = true;
    if (update.examined === undefined) {
      connection.exec("DELETE FROM replication_conflicts");
    } else {
      connection
        .query("DELETE FROM replication_conflicts WHERE id IN (SELECT value FROM json_each(?))")
        .run(JSON.stringify(update.examined));
    }
    for (const conflict of update.conflicts) {
      connection
        .query("INSERT INTO replication_conflicts VALUES(?,?)")
        .run(conflict.id, JSON.stringify(conflict));
    }
  }
  for (const id of update.acknowledged ?? []) {
    changed = true;
    connection.query("DELETE FROM replication_outbox WHERE id=?").run(id);
  }
  if (update.decision !== undefined) {
    const previous = connection
      .query<ReplicationJsonRow, [string]>("SELECT json FROM replication_resolutions WHERE id=?")
      .get(update.decision.resolutionId);
    if (previous?.json !== canonicalJson(update.decision)) {
      changed = true;
      connection
        .query("INSERT INTO replication_resolutions VALUES(?,?,?)")
        .run(update.decision.resolutionId, update.decision.id, canonicalJson(update.decision));
    }
  }
  if (changed) {
    connection.exec("UPDATE replication_state SET revision=revision+1 WHERE singleton=1");
  }
}

/**
 * Читает скалярный guard без полного remote JSON и без пользовательских карточек.
 */
export function readReplicationGuard(connection: Database): ReplicationGuard {
  const row = connection
    .query<ReplicationGuard, []>(
      "SELECT replica_id AS replicaId,sequence,revision,generation FROM replication_state JOIN project_state USING(singleton) WHERE singleton=1",
    )
    .get();
  if (row === null) {
    throw new RelayError("DATABASE_INVALID", storageReplicationMessages.stateMissing, 1);
  }
  return row;
}

/**
 * Читает status узкими SQL-счётчиками без декодирования payload outbox или полного snapshot.
 */
export function readReplicationStatus(connection: Database): ReplicationStatus {
  const guard = readReplicationGuard(connection);
  const counters = connection
    .query<Pick<ReplicationStatus, "pending" | "oldest" | "conflicts">, []>(
      `SELECT
    (SELECT count(*) FROM replication_outbox) AS pending,
    (SELECT json_extract(json,'$.createdAt') FROM replication_outbox ORDER BY sequence LIMIT 1) AS oldest,
    (SELECT count(*) FROM replication_conflicts) AS conflicts`,
    )
    .get();
  if (counters === null) {
    throw new RelayError("DATABASE_INVALID", storageReplicationMessages.stateMissing, 1);
  }
  return {
    ...counters,
    replicaId: guard.replicaId,
    generation: guard.generation,
    transportVersion: guard.revision,
  };
}
