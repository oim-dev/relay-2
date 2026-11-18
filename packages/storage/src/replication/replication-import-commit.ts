import type { Database } from "bun:sqlite";
import { RelayError } from "@relay/contracts";
import { appendComment } from "../entities/entity-writes";
import { insertBatchReceipt } from "../batch/batch-receipts";
import { applyComponentImportDelta } from "../components/component-store";
import type { ReplicationImportPlan } from "./replication.types";
import { storageReplicationMessages } from "./replication.messages";
import { insertRawEntity, removeRawEntity, updateRawEntity } from "../relational/entity-store";
import { assignCurrentKey, releaseCurrentKeys } from "../relational/key-store";

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
  releaseCurrentKeys(
    connection,
    plan.entities
      .filter(
        (entry) =>
          entry.before !== null &&
          (entry.after === null || entry.before.record.key !== entry.after.record.key),
      )
      .map((entry) => entry.id),
  );
  applyComponentImportDelta(connection, [], plan.componentRemovals);
  for (const entry of plan.commentsRemoved) {
    connection.query("DELETE FROM task_comments WHERE id=?").run(entry.comment.id);
  }
  for (const entry of plan.entities) {
    if (entry.after === null) {
      removeRawEntity(connection, entry.id);
    }
  }
  for (const entry of plan.entities) {
    if (entry.after === null) {
      continue;
    }
    const previous = revisions.get(entry.id);
    if (entry.before === null) {
      insertRawEntity(connection, { ...entry.after.record, revision: 1 }, { keyMode: "defer" });
    } else if (
      previous === undefined ||
      !updateRawEntity(
        connection,
        {
          ...entry.after.record,
          revision: entry.after.record.kind === "work-checkpoint" ? 1 : previous.revision + 1,
        },
        previous.revision,
        { keyMode: "defer" },
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
  const importedAddresses = new Set(
    plan.componentUpserts.flatMap((part) =>
      part.kind === "address-assignment" && !part.deleted
        ? [JSON.stringify([part.ownerId, part.value.ref])]
        : [],
    ),
  );
  for (const entry of plan.entities) {
    if (
      entry.after !== null &&
      (entry.before === null ||
        entry.before.record.key !== entry.after.record.key ||
        importedAddresses.has(JSON.stringify([entry.id, entry.after.record.key])))
    ) {
      assignCurrentKey(connection, entry.id, entry.after.record.key, { create: false });
    }
  }
  for (const entry of plan.remapped) {
    connection
      .query(
        "INSERT INTO replication_remapped_refs VALUES(?,?,?) ON CONFLICT(ref) DO UPDATE SET current_id=excluded.current_id",
      )
      .run(entry.ref, entry.previousId, entry.currentId);
  }
  for (const entry of plan.commentsAdded) {
    appendComment(connection, entry.taskId, entry.comment, entry.after);
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
 * Меняет физический порядок только затронутых журналов; sequence других задач не переписывается.
 */
function reorderImportedComments(connection: Database, plan: ReplicationImportPlan): void {
  if (plan.commentOrder.length === 0) {
    return;
  }
  let sequence =
    connection
      .query<{ value: number }, []>(
        "SELECT coalesce(max(sequence),0) AS value FROM local_comment_sequences",
      )
      .get()?.value ?? 0;
  connection
    .query(
      `UPDATE local_comment_sequences SET sequence=-sequence
       WHERE comment_id IN (SELECT id FROM task_comments
         WHERE task_id IN (SELECT value FROM json_each(?)))`,
    )
    .run(JSON.stringify(plan.commentOrder.map((entry) => entry.taskId)));
  const update = connection.query(
    "UPDATE local_comment_sequences SET sequence=? WHERE comment_id=?",
  );
  for (const journal of plan.commentOrder) {
    for (const id of journal.ids) {
      update.run(++sequence, id);
    }
  }
}
