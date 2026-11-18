import { isEntityKind, type EntityKind, type PortableEntityRecord } from "@relay/contracts";
import { ENTITY_DEFINITIONS } from "./entity-definitions";
import {
  assertKnownFields,
  decodeColumns,
  encodeColumns,
  identityText,
  invalidRow,
  rowObject,
  encodeText,
  decodeText,
} from "./columns";
import type { SqlRow } from "./columns.types";
import type { CheckpointReferenceRow, CheckpointAcceptanceRow } from "./rows.types";

const derivedFields: Readonly<Partial<Record<EntityKind, readonly string[]>>> = {
  application: ["boardId", "prefix"],
  implementation: ["featureId", "scenarioId", "targetId", "targetKind", "active"],
  "work-session": ["currentRunId"],
  "work-checkpoint": ["references", "acceptedSessionIds"],
};

/**
 * Превращает совместимый raw owner без коллекций компонентов в одну предметную строку.
 * UUID, время и авторство передаются дословно; ключ хранит исключительно object_keys.
 */
export function encodeEntityRow(record: PortableEntityRecord, projectId: string): SqlRow {
  if (!isEntityKind(record.kind)) {
    invalidRow("kind");
  }
  rowObject(record.data, "data");
  const definition = ENTITY_DEFINITIONS[record.kind];
  assertKnownFields(record.data, definition.columns, derivedFields[record.kind]);
  const row: SqlRow = {
    id: identityText(record.id, "id"),
    created_at: identityText(record.createdAt, "createdAt"),
    updated_at: identityText(record.updatedAt, "updatedAt"),
    created_by: identityText(record.createdBy, "createdBy"),
    updated_by: identityText(record.updatedBy, "updatedBy"),
    ...encodeColumns(definition.columns, record.data),
  };
  identityText(record.key, "key");
  if (record.kind === "product" || record.kind === "document") {
    row.project_id = identityText(projectId, "projectId");
  }
  if (record.kind === "application") {
    identityText(record.data.boardId, "boardId");
    identityText(record.data.prefix, "prefix");
  }
  if (record.kind === "implementation") {
    Object.assign(row, implementationTarget(record.data));
  }
  if (record.kind === "work-session" && record.data.currentRunId !== null) {
    identityText(record.data.currentRunId, "currentRunId");
  }
  return row;
}

/**
 * Разлагает два допустимых варианта реализации, отвергая противоречивые дубли старого DTO.
 */
function implementationTarget(data: Readonly<Record<string, unknown>>): SqlRow {
  const featureId = identityText(data.featureId, "featureId");
  const targetId = identityText(data.targetId, "targetId");
  if (typeof data.active !== "boolean") {
    invalidRow("active");
  }
  if (
    data.targetKind === "feature" &&
    targetId === featureId &&
    !Object.hasOwn(data, "scenarioId")
  ) {
    return { feature_id: featureId, scenario_id: null };
  }
  if (data.targetKind === "scenario" && targetId === identityText(data.scenarioId, "scenarioId")) {
    return { feature_id: null, scenario_id: targetId };
  }
  return invalidRow("targetKind/targetId");
}

/**
 * Собирает скаляры совместимой записи; производные связи передаются явным предметным контекстом.
 */
export function decodeEntityRow(
  kind: EntityKind,
  row: Readonly<SqlRow>,
  key: string,
  derived: Readonly<Record<string, unknown>> = {},
): PortableEntityRecord {
  return {
    id: identityText(row.id, "id"),
    kind,
    key: identityText(key, "key"),
    createdAt: identityText(row.created_at, "created_at"),
    updatedAt: identityText(row.updated_at, "updated_at"),
    createdBy: identityText(row.created_by, "created_by"),
    updatedBy: identityText(row.updated_by, "updated_by"),
    data: { ...decodeColumns(ENTITY_DEFINITIONS[kind].columns, row), ...derived },
  };
}

/**
 * Нормализует неизменяемые снимки ссылок checkpoint, включая исторические ключи и точные заголовки.
 */
export function encodeCheckpointReferences(record: PortableEntityRecord): CheckpointReferenceRow[] {
  const references = record.data.references;
  if (!Array.isArray(references)) {
    return invalidRow("references");
  }
  return references.map((reference: unknown, position) => {
    const value = rowObject(reference, "references");
    assertKnownFields(value, [], ["id", "kind", "key", "title"]);
    if (typeof value.title !== "string") {
      return invalidRow("references.title");
    }
    const targetKind = value.kind;
    if (typeof targetKind !== "string" || !Object.hasOwn(ENTITY_DEFINITIONS, targetKind)) {
      return invalidRow("references.kind");
    }
    const title = encodeText(value.title, "snapshot_title");
    // Вид проверен закрытым каталогом; carrier создаётся только encodeText.
    return {
      checkpoint_id: record.id,
      target_id: identityText(value.id, "references.id"),
      target_kind: targetKind as EntityKind,
      position,
      snapshot_key: identityText(value.key, "references.key"),
      snapshot_title: title.snapshot_title,
      snapshot_title_json: title.snapshot_title_json,
    } as CheckpointReferenceRow;
  });
}

/**
 * Нормализует факты приёмки в исходном порядке без актуализации состояния дочерних сессий.
 */
export function encodeCheckpointAcceptances(
  record: PortableEntityRecord,
): CheckpointAcceptanceRow[] {
  const accepted = record.data.acceptedSessionIds;
  if (!Array.isArray(accepted)) {
    return invalidRow("acceptedSessionIds");
  }
  return accepted.map((id: unknown, position) => ({
    checkpoint_id: record.id,
    child_session_id: identityText(id, "acceptedSessionIds"),
    position,
  }));
}

/**
 * Собирает только сохранённые исторические подписи; текущие предметные строки не читаются.
 */
export function decodeCheckpointReferences(rows: readonly CheckpointReferenceRow[]): unknown[] {
  return [...rows]
    .sort((a, b) => a.position - b.position)
    .map((row) => ({
      id: row.target_id,
      kind: row.target_kind,
      key: row.snapshot_key,
      title: decodeText({ ...row }, "snapshot_title") ?? invalidRow("snapshot_title"),
    }));
}
