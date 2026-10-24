import type { Database } from "bun:sqlite";
import { RelayError } from "@relay/contracts";
import { insertEntity, updateEntity, appendComment } from "../entities/entity-writes";
import { insertBatchReceipt } from "../batch/batch-receipts";
import { applyComponentImportDelta } from "../components/component-store";
import type { ReplicationImportPlan } from "./replication.types";
import { storageReplicationMessages } from "./replication.messages";
import { replicationFingerprint } from "./portable-version";

/**
 * Применяет только подготовленные строки под внешним guarded commit; полного capture/merge здесь нет.
 * Локальные CAS читаются одним адресным запросом и монотонно повышаются при изменении owner/parts.
 */
export function commitReplicationImport(connection: Database, plan: ReplicationImportPlan): void {
  const ids = plan.entities.map((entry) => entry.id);
  const revisions = new Map(
    connection
      .query<{ id: string; revision: number; version: string }, [string]>(
        "SELECT e.id,e.revision,v.version FROM entities e LEFT JOIN replication_entity_versions v ON v.entity_id=e.id WHERE e.id IN (SELECT value FROM json_each(?))",
      )
      .all(JSON.stringify(ids))
      .map((row) => [row.id, row]),
  );
  for (const entry of plan.entities) {
    if (
      (entry.before === null && revisions.has(entry.id)) ||
      (entry.before !== null && revisions.get(entry.id)?.version !== entry.before.version)
    ) {
      throw new RelayError(
        "REPLICATION_LOCAL_CHANGED",
        storageReplicationMessages.corruptVersion,
        4,
        { id: entry.id },
      );
    }
  }
  connection.exec("UPDATE replication_state SET importing=1 WHERE singleton=1");
  applyComponentImportDelta(connection, [], plan.componentRemovals);
  for (const entry of plan.commentsRemoved) {
    connection.query("DELETE FROM replication_comment_order WHERE id=?").run(entry.comment.id);
    connection.query("DELETE FROM task_comments WHERE id=?").run(entry.comment.id);
  }
  for (const entry of plan.entities) {
    if (entry.after === null) {
      connection.query("DELETE FROM entities WHERE id=?").run(entry.id);
    } else if (entry.before !== null && entry.before.record.key !== entry.after.record.key) {
      connection
        .query("UPDATE entities SET key=? WHERE id=?")
        .run(temporaryImportKey(connection, entry.id), entry.id);
    }
  }
  for (const entry of plan.entities) {
    if (entry.after === null) {
      continue;
    }
    const previous = revisions.get(entry.id);
    if (entry.before === null) {
      insertEntity(connection, { ...entry.after.record, revision: 1 });
    } else if (
      previous === undefined ||
      !updateEntity(
        connection,
        { ...entry.after.record, revision: previous.revision + 1 },
        previous.revision,
      )
    ) {
      throw new RelayError(
        "REPLICATION_LOCAL_CHANGED",
        storageReplicationMessages.corruptVersion,
        4,
        { id: entry.id },
      );
    }
    if (entry.before?.version !== entry.after.version) {
      connection
        .query(
          "INSERT INTO replication_entity_versions VALUES(?,?,?) ON CONFLICT(entity_id) DO UPDATE SET version=excluded.version,parents_json=excluded.parents_json",
        )
        .run(entry.id, entry.after.version, JSON.stringify(entry.after.parents ?? []));
    }
  }
  applyComponentImportDelta(connection, plan.componentUpserts, []);
  for (const entry of plan.remapped) {
    connection
      .query(
        "INSERT INTO replication_remapped_refs VALUES(?,?,?) ON CONFLICT(ref) DO UPDATE SET current_id=excluded.current_id",
      )
      .run(entry.ref, entry.previousId, entry.currentId);
  }
  for (const entry of plan.commentsAdded) {
    appendComment(connection, entry.taskId, entry.comment);
    connection
      .query("UPDATE replication_comment_order SET after_id=? WHERE id=?")
      .run(entry.after, entry.comment.id);
  }
  reorderImportedComments(connection, plan);
  for (const receipt of plan.receiptsAdded) {
    insertBatchReceipt(connection, receipt);
  }
  if (
    plan.entities.length +
      plan.componentUpserts.length +
      plan.componentRemovals.length +
      plan.commentsAdded.length +
      plan.commentsRemoved.length >
    0
  ) {
    connection.exec("UPDATE project_state SET generation=generation+1 WHERE singleton=1");
  }
  connection.exec("UPDATE replication_state SET importing=0 WHERE singleton=1");
}

/**
 * Выделяет временный SQL-ключ без двоеточия и столкновения с другой карточкой внутри commit.
 * Он не записывается в assignments, не виден читателям и заменяется конечным ключом до commit.
 */
function temporaryImportKey(connection: Database, id: string): string {
  const prefix = `~relay-import-${replicationFingerprint(id)}`;
  let key = prefix;
  let suffix = 0;
  const occupied = connection.query("SELECT 1 FROM entities WHERE key=?");
  while (occupied.get(key) !== null) {
    key = `${prefix}-${++suffix}`;
  }
  return key;
}

/**
 * Меняет физический порядок только затронутых журналов; sequence других задач не переписывается.
 */
function reorderImportedComments(connection: Database, plan: ReplicationImportPlan): void {
  if (plan.commentOrder.length === 0) {
    return;
  }
  let sequence =
    connection
      .query<{ value: number }, []>("SELECT coalesce(max(sequence),0) AS value FROM task_comments")
      .get()?.value ?? 0;
  connection
    .query(
      "UPDATE task_comments SET sequence=-sequence WHERE task_id IN (SELECT value FROM json_each(?))",
    )
    .run(JSON.stringify(plan.commentOrder.map((entry) => entry.taskId)));
  const update = connection.query("UPDATE task_comments SET sequence=? WHERE id=?");
  for (const journal of plan.commentOrder) {
    for (const id of journal.ids) {
      update.run(++sequence, id);
    }
  }
}
