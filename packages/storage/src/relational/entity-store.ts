import type { Database } from "bun:sqlite";
import { RelayError, type EntityRecord, type EntityKind } from "@relay/contracts";
import { ENTITY_DEFINITIONS } from "./entity-definitions";
import { COMPONENT_DEFINITIONS } from "./component-definitions";
import {
  encodeEntityRow,
  encodeCheckpointReferences,
  encodeCheckpointAcceptances,
} from "./entity-codec";
import { identityText, invalidRow } from "./columns";
import {
  insertSqlRow,
  requireRelationalImport,
  requireRelationalTransaction,
  upsertSqlRow,
} from "./sql-write";
import { assignCurrentKey } from "./key-store";
import { relationalMessages } from "./relational.messages";
import type { RelationalWriteOptions } from "./write.types";
import type { SqlRow } from "./columns.types";

/**
 * Читает локальную привязку единственного проекта даже до появления его строки при bootstrap.
 */
function projectId(db: Database): string {
  const row = db
    .query<{ project_id: string }, []>("SELECT project_id FROM project_state WHERE singleton=1")
    .get();
  return identityText(row?.project_id, "projectId");
}

/**
 * Проверяет числовую local CAS-ревизию отдельно от любых переносимых полей.
 */
function checkRevision(revision: number): void {
  if (!Number.isSafeInteger(revision) || revision < 1) {
    throw new RelayError("CONFLICT", relationalMessages.revision, 4, { revision });
  }
}

/**
 * Добавляет нормализованные исторические ссылки нового материала после проверки всех его полей.
 */
function insertCheckpointRelations(db: Database, record: EntityRecord): void {
  const references = encodeCheckpointReferences(record);
  const acceptances = encodeCheckpointAcceptances(record);
  for (const row of references) {
    insertSqlRow(db, "checkpoint_references", { ...row });
  }
  for (const row of acceptances) {
    insertSqlRow(db, "checkpoint_acceptances", { ...row });
  }
}

/**
 * Создаёт identity, предметную строку и локальный CAS в транзакции вызывающего.
 * record.data уже отделён от PortableComponent. keyMode:defer нужен при внешнем exact address writer.
 * Не изменяет поколение, не вычисляет версии содержания и не создаёт outbox/предметные события.
 */
export function insertRawEntity(
  db: Database,
  record: EntityRecord,
  options: RelationalWriteOptions = {},
): void {
  requireRelationalTransaction(db);
  checkRevision(record.revision);
  const row = encodeEntityRow(record, projectId(db));
  if (record.kind === "work-checkpoint") {
    if (record.revision !== 1) {
      throw new RelayError("CONFLICT", relationalMessages.revision, 4, { id: record.id });
    }
    encodeCheckpointReferences(record);
    encodeCheckpointAcceptances(record);
  }
  insertSqlRow(db, "object_ids", { id: record.id, kind: record.kind });
  if (record.kind === "work-checkpoint") {
    // Отложенный FK позволяет создать отношения до материала; после INSERT материал запечатывает их.
    insertCheckpointRelations(db, record);
  }
  insertSqlRow(db, ENTITY_DEFINITIONS[record.kind].table, row);
  insertSqlRow(db, "local_entity_revisions", { entity_id: record.id, revision: record.revision });
  if (options.keyMode !== "defer") {
    assignCurrentKey(db, record.id, record.key, options);
  }
}

/**
 * Проверяет совпадение неизменяемых метаданных до первого изменения любых таблиц.
 */
function checkImmutableMetadata(db: Database, record: EntityRecord): void {
  const identity = db
    .query<{ kind: EntityKind }, [string]>("SELECT kind FROM object_ids WHERE id=?")
    .get(record.id);
  if (identity === null) {
    invalidRow("identity");
  }
  if (identity.kind !== record.kind) {
    throw new RelayError("CONFLICT", relationalMessages.immutable, 4, { id: record.id });
  }
  const table = ENTITY_DEFINITIONS[record.kind].table;
  const row = db
    .query<SqlRow, [string]>(`SELECT created_at,created_by FROM ${table} WHERE id=?`)
    .get(record.id);
  if (row === null) {
    invalidRow("entity");
  }
  if (row.created_at !== record.createdAt || row.created_by !== record.createdBy) {
    throw new RelayError("CONFLICT", relationalMessages.immutable, 4, { id: record.id });
  }
}

/**
 * Проверяет неизменяемые нормализованные отношения checkpoint даже при update только local CAS.
 */
function checkCheckpointRelations(db: Database, record: EntityRecord): void {
  const references = db
    .query<SqlRow, [string]>(
      "SELECT * FROM checkpoint_references WHERE checkpoint_id=? ORDER BY position",
    )
    .all(record.id);
  const acceptances = db
    .query<SqlRow, [string]>(
      "SELECT * FROM checkpoint_acceptances WHERE checkpoint_id=? ORDER BY position",
    )
    .all(record.id);
  const expectedReferences = encodeCheckpointReferences(record);
  const expectedAcceptances = encodeCheckpointAcceptances(record);
  for (const [actual, expected] of [
    [references, expectedReferences],
    [acceptances, expectedAcceptances],
  ] as const) {
    if (
      actual.length !== expected.length ||
      expected.some((row, index) =>
        Object.entries(row).some(([field, value]) => actual[index]?.[field] !== value),
      )
    ) {
      throw new RelayError("CONFLICT", relationalMessages.immutableHistory, 4, {
        id: record.id,
      });
    }
  }
}

/**
 * Выполняет CAS владельца без побочных действий при несовпадении ожидаемой ревизии.
 * Успех сохраняет переданные скаляры и revision; комментарии и компоненты не переписываются.
 * В importing допустим прежний CAS неизменяемого checkpoint; обычный update увеличивает CAS на один.
 */
export function updateRawEntity(
  db: Database,
  record: EntityRecord,
  expectedRevision: number,
  options: RelationalWriteOptions = {},
): boolean {
  requireRelationalTransaction(db);
  identityText(record.id, "id");
  const current = db
    .query<{ revision: number }, [string]>(
      "SELECT revision FROM local_entity_revisions WHERE entity_id=?",
    )
    .get(record.id);
  if (current === null || current.revision !== expectedRevision) {
    return false;
  }
  checkRevision(record.revision);
  const importing =
    db
      .query<{ importing: number }, []>("SELECT importing FROM replication_state WHERE singleton=1")
      .get()?.importing === 1;
  if (
    record.revision !== expectedRevision + 1 &&
    !(importing && record.revision === expectedRevision)
  ) {
    throw new RelayError("CONFLICT", relationalMessages.revision, 4, {
      id: record.id,
      expectedRevision,
      revision: record.revision,
    });
  }
  checkImmutableMetadata(db, record);
  const row = encodeEntityRow(record, projectId(db));
  if (record.kind === "work-checkpoint") {
    if (record.revision !== 1) {
      throw new RelayError("CONFLICT", relationalMessages.revision, 4, { id: record.id });
    }
    checkCheckpointRelations(db, record);
  }
  upsertSqlRow(db, ENTITY_DEFINITIONS[record.kind].table, row, ["id"]);
  db.query("UPDATE local_entity_revisions SET revision=? WHERE entity_id=? AND revision=?").run(
    record.revision,
    record.id,
    expectedRevision,
  );
  if (options.keyMode !== "defer") {
    assignCurrentKey(db, record.id, record.key, options);
  }
  return true;
}

/**
 * Физически удаляет owner и принадлежащие ему строки только под technical import.
 * Ссылки чужих владельцев не удаляет: их итоговую корректность проверяют отложенные предметные FK.
 * Отсутствующий ID — no-op; версии, очередь и events обслуживает интегратор.
 */
export function removeRawEntity(db: Database, id: string): void {
  requireRelationalImport(db);
  identityText(id, "id");
  const identity = db
    .query<{ kind: EntityKind }, [string]>("SELECT kind FROM object_ids WHERE id=?")
    .get(id);
  if (identity === null) {
    return;
  }
  for (const definition of Object.values(COMPONENT_DEFINITIONS)) {
    db.query(`DELETE FROM ${definition.table} WHERE owner_id=?`).run(id);
  }
  if (identity.kind === "work-checkpoint") {
    db.query("DELETE FROM checkpoint_references WHERE checkpoint_id=?").run(id);
    db.query("DELETE FROM checkpoint_acceptances WHERE checkpoint_id=?").run(id);
  }
  if (identity.kind === "task") {
    db.query("DELETE FROM task_comments WHERE task_id=?").run(id);
  }
  db.query(`DELETE FROM ${ENTITY_DEFINITIONS[identity.kind].table} WHERE id=?`).run(id);
  db.query("DELETE FROM object_ids WHERE id=?").run(id);
}
