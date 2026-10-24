import type { Database } from "bun:sqlite";
import { RelayError, componentIdentity, type PortableProjectSnapshot } from "@relay/contracts";
import { insertEntity, appendComment, updateEntity } from "../entities/entity-writes";
import { insertBatchReceipt } from "../batch/batch-receipts";
import { captureStoredProject } from "./replication-store";
import { canonicalJson } from "./portable-version";
import { storageReplicationMessages } from "./replication.messages";
import { replaceComponents } from "../components/component-store";
import { commitReplicationImport } from "./replication-import-commit";
import type { ReplicationImportPlan } from "./replication.types";

/**
 * Применяет проверенный Core снимок строками, сохраняя локальные CAS и неизменяемые журналы.
 * Вызывающий удерживает outer transaction; импорт не создаёт echo-outbox.
 * Удаления допустимы только для отвергнутых неопубликованных записей, что проверяет Core.
 */
export function importStoredProject(
  connection: Database,
  snapshot: PortableProjectSnapshot,
  plan?: ReplicationImportPlan,
): void {
  if (plan !== undefined) {
    commitReplicationImport(connection, plan);
    return;
  }
  const current = captureStoredProject(connection, snapshot.projectId);
  const existing = new Map(current.entities.map((entry) => [entry.record.id, entry]));
  const incoming = new Map(snapshot.entities.map((entry) => [entry.record.id, entry]));
  const comments = new Map(current.comments.map((entry) => [entry.comment.id, entry]));
  const receipts = new Map(current.receipts.map((entry) => [entry.operationKey, entry]));
  const revisions = new Map(
    connection
      .query<{ id: string; revision: number }, []>("SELECT id,revision FROM entities")
      .all()
      .map((row) => [row.id, row.revision]),
  );
  const sameAddresses =
    canonicalJson(
      Object.fromEntries(current.addresses.map((entry) => [entry.ref, entry.entityId])),
    ) ===
    canonicalJson(
      Object.fromEntries(snapshot.addresses.map((entry) => [entry.ref, entry.entityId])),
    );
  const sameEntities =
    current.entities.length === snapshot.entities.length &&
    snapshot.entities.every((entry) => existing.get(entry.record.id)?.version === entry.version);
  const componentVersions = new Map(
    (current.components ?? []).map((entry) => [componentIdentity(entry), entry.version]),
  );
  const changedComponentOwners = new Set(
    (snapshot.components ?? [])
      .filter((entry) => componentVersions.get(componentIdentity(entry)) !== entry.version)
      .map((entry) => entry.ownerId),
  );
  const incomingParts = new Set((snapshot.components ?? []).map(componentIdentity));
  for (const part of current.components ?? []) {
    if (!incomingParts.has(componentIdentity(part))) {
      changedComponentOwners.add(part.ownerId);
    }
  }
  const sameComments =
    current.comments.length === snapshot.comments.length &&
    snapshot.comments.every(
      (entry) => canonicalJson(comments.get(entry.comment.id)) === canonicalJson(entry),
    );
  const sameReceipts =
    current.receipts.length === snapshot.receipts.length &&
    snapshot.receipts.every(
      (entry) => canonicalJson(receipts.get(entry.operationKey)) === canonicalJson(entry),
    );
  if (
    sameEntities &&
    changedComponentOwners.size === 0 &&
    sameAddresses &&
    sameComments &&
    sameReceipts
  ) {
    return;
  }
  let changed = false;
  connection.exec("UPDATE replication_state SET importing=1 WHERE singleton=1");
  const incomingAddresses = new Map(snapshot.addresses.map((entry) => [entry.ref, entry.entityId]));
  for (const address of current.addresses) {
    const owner = incomingAddresses.get(address.ref);
    if (owner !== undefined && owner !== address.entityId) {
      connection
        .query(
          "INSERT INTO replication_remapped_refs VALUES(?,?,?) ON CONFLICT(ref) DO UPDATE SET current_id=excluded.current_id",
        )
        .run(address.ref, address.entityId, owner);
    }
  }
  // Все назначения заменяются вместе: это позволяет освободить проигравший предварительный ключ.
  connection.exec("DELETE FROM entity_refs");
  for (const entry of current.entities) {
    if (!incoming.has(entry.record.id)) {
      connection
        .query(
          "DELETE FROM replication_comment_order WHERE id IN (SELECT id FROM task_comments WHERE task_id=?)",
        )
        .run(entry.record.id);
      connection.query("DELETE FROM task_comments WHERE task_id=?").run(entry.record.id);
      connection.query("DELETE FROM entities WHERE id=?").run(entry.record.id);
      changed = true;
    } else if (entry.record.key !== incoming.get(entry.record.id)?.record.key) {
      // Временный адрес не попадает в aliases и освобождается до commit; CAS увеличивается лишь ниже.
      connection
        .query("UPDATE entities SET key=? WHERE id=?")
        .run(`~${crypto.randomUUID()}`, entry.record.id);
    }
  }
  for (const entry of snapshot.entities) {
    const previous = existing.get(entry.record.id);
    if (previous === undefined) {
      insertEntity(connection, { ...entry.record, revision: 1 });
      changed = true;
    } else if (previous.version !== entry.version || changedComponentOwners.has(entry.record.id)) {
      const updated = updateEntity(
        connection,
        {
          ...entry.record,
          revision: (revisions.get(entry.record.id) ?? 0) + 1,
        },
        revisions.get(entry.record.id) ?? 0,
      );
      if (!updated) {
        throw new RelayError(
          "REPLICATION_LOCAL_CHANGED",
          storageReplicationMessages.corruptVersion,
          4,
          { id: entry.record.id },
        );
      }
      changed = true;
    }
    connection
      .query(
        "INSERT INTO replication_entity_versions VALUES(?,?,?) ON CONFLICT(entity_id) DO UPDATE SET version=excluded.version,parents_json=excluded.parents_json",
      )
      .run(entry.record.id, entry.version, JSON.stringify(entry.parents ?? []));
  }
  replaceComponents(connection, snapshot.components ?? []);
  const retainedComments = new Set(snapshot.comments.map((entry) => entry.comment.id));
  for (const entry of current.comments) {
    if (!retainedComments.has(entry.comment.id)) {
      connection.query("DELETE FROM replication_comment_order WHERE id=?").run(entry.comment.id);
      connection.query("DELETE FROM task_comments WHERE id=?").run(entry.comment.id);
      changed = true;
    }
  }
  for (const entry of snapshot.comments) {
    const previous = comments.get(entry.comment.id);
    if (previous !== undefined) {
      if (canonicalJson(previous) !== canonicalJson(entry)) {
        throw new RelayError(
          "REPLICATION_IMMUTABLE",
          storageReplicationMessages.immutableComment,
          4,
          { id: entry.comment.id },
        );
      }
    } else {
      appendComment(connection, entry.taskId, entry.comment);
      connection
        .query("UPDATE replication_comment_order SET after_id=? WHERE id=?")
        .run(entry.after, entry.comment.id);
      changed = true;
    }
  }
  for (const receipt of snapshot.receipts) {
    const previous = receipts.get(receipt.operationKey);
    if (previous === undefined) {
      insertBatchReceipt(connection, receipt);
    } else if (canonicalJson(previous) !== canonicalJson(receipt)) {
      throw new RelayError(
        "REPLICATION_IMMUTABLE",
        storageReplicationMessages.immutableReceipt,
        4,
        { operationKey: receipt.operationKey },
      );
    }
  }
  if (snapshot.comments.length > 0) {
    const children = new Map<string | null, string[]>();
    for (const entry of snapshot.comments) {
      const siblings = children.get(entry.after) ?? [];
      siblings.push(entry.comment.id);
      children.set(entry.after, siblings);
    }
    for (const siblings of children.values()) {
      siblings.sort();
    }
    const stack = [...(children.get(null) ?? [])].reverse();
    connection.exec("UPDATE task_comments SET sequence=-sequence");
    let sequence = 0;
    while (stack.length > 0) {
      const id = stack.pop();
      if (id !== undefined) {
        connection.query("UPDATE task_comments SET sequence=? WHERE id=?").run(++sequence, id);
        stack.push(...[...(children.get(id) ?? [])].reverse());
      }
    }
  }
  if (changed || !sameAddresses) {
    connection.exec("UPDATE project_state SET generation=generation+1 WHERE singleton=1");
  }
  connection.exec("UPDATE replication_state SET importing=0 WHERE singleton=1");
}
