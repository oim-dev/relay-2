import { RELATIONAL_TABLES } from "./catalog";
import type { RelationalTableDescriptor } from "./catalog.types";
import { columnNames, decodeText, identityText, invalidRow, rowObject } from "./columns";
import type { SqlRow } from "./columns.types";
import { decodeComponentRow } from "./component-codec";
import { COMPONENT_DEFINITIONS } from "./component-definitions";
import { decodeEntityRow } from "./entity-codec";
import { ENTITY_DEFINITIONS } from "./entity-definitions";
import {
  decodePortableComment,
  decodePortableConfirmation,
  decodePortableReceipt,
} from "./portable-codec-metadata";
import { decodePortablePublication } from "./portable-codec-publication";
import {
  exactFields,
  portableArray,
  portableId,
  portableInteger,
  portableJson,
  portableKind,
  portableParents,
  portableSqlRow,
  portableVersion,
} from "./portable-codec-values";
import type { PortableTableMap, PortableTableRows } from "./rows.types";

const entityMetadata = ["id", "created_at", "updated_at", "created_by", "updated_by"] as const;
const componentMetadata = [
  "owner_id",
  "id",
  "position",
  "version",
  "parents_json",
  "deleted",
] as const;

/**
 * Проверяет закрытый envelope, каждую физическую колонку и PK до появления типизированной карты.
 * Ссылки между таблицами проверяет отдельный проход перед построением DTO.
 */
export function decodePortableTableShape(value: unknown): PortableTableRows {
  const input = rowObject(value, "portableRows");
  exactFields(input, ["projectId", "tables"]);
  const projectId = portableId(input.projectId, "projectId");
  const tables: unknown = input.tables;
  assertPortableTables(tables);
  return { projectId, tables };
}

/**
 * Полностью проверяет строки закрытого каталога, включая технический JSON и ключи.
 * Утверждение карты опирается на обязательность всех таблиц и проверку каждой их колонки.
 */
function assertPortableTables(value: unknown): asserts value is PortableTableMap {
  const tables = rowObject(value, "tables");
  const descriptors = RELATIONAL_TABLES.filter((table) => table.portable);
  exactFields(
    tables,
    descriptors.map((table) => table.name),
  );
  for (const table of descriptors) {
    const keys = new Set<string>();
    for (const entry of portableArray(tables[table.name], table.name)) {
      const row = portableSqlRow(entry);
      validateTableRow(table, row);
      const key = JSON.stringify(table.primaryKey.map((column) => portableId(row[column], column)));
      if (keys.has(key)) {
        invalidRow(`${table.name}.primaryKey`);
      }
      keys.add(key);
    }
  }
}

/**
 * Проверяет единственную строку её владельцем колонок; технические таблицы имеют явную форму.
 */
function validateTableRow(table: RelationalTableDescriptor, row: Readonly<SqlRow>): void {
  if (table.entityKind !== undefined) {
    const kind = table.entityKind;
    const additional: string[] = [];
    if (kind === "implementation") {
      additional.push("feature_id", "scenario_id");
    } else if (kind === "product" || kind === "document") {
      additional.push("project_id");
    }
    exactFields(row, [
      ...entityMetadata,
      ...columnNames(ENTITY_DEFINITIONS[kind].columns),
      ...additional,
    ]);
    portableId(row.id, "id");
    decodeEntityRow(kind, row, "shape");
    if (kind === "implementation") {
      assertTarget(row, ["feature_id", "scenario_id"]);
    } else if (kind === "product" || kind === "document") {
      portableId(row.project_id, "project_id");
    }
    return;
  }
  if (table.componentKind !== undefined) {
    const kind = table.componentKind;
    const additional: string[] = [];
    if (kind === "task-target") {
      additional.push("feature_id", "scenario_id", "implementation_id");
    } else if (kind === "address-assignment") {
      additional.push("is_current");
    }
    exactFields(row, [
      ...componentMetadata,
      ...columnNames(COMPONENT_DEFINITIONS[kind].columns),
      ...additional,
    ]);
    portableId(row.owner_id, "owner_id");
    portableId(row.id, "id");
    portableVersion(row.version, "version");
    // Синтаксис parents проверяется до общего row decoder, который ожидает JSON.
    portableParents(portableJson(row.parents_json, "parents_json"));
    decodeComponentRow(kind, row);
    if (kind === "address-assignment" && row.is_current !== 0 && row.is_current !== 1) {
      invalidRow("is_current");
    }
    return;
  }
  validateTechnicalRow(table.name, row);
}

/**
 * Требует ровно один типизированный FK из взаимоисключающих колонок.
 */
function assertTarget(row: Readonly<SqlRow>, columns: readonly string[]): void {
  const targets = columns.filter((column) => row[column] !== null);
  if (targets.length !== 1) {
    invalidRow("target");
  }
  for (const column of targets) {
    portableId(row[column], column);
  }
}

/**
 * Проверяет закрытые формы неизменяемых материалов и репликационных метаданных.
 */
function validateTechnicalRow(
  name: RelationalTableDescriptor["name"],
  row: Readonly<SqlRow>,
): void {
  switch (name) {
    case "object_ids":
      exactFields(row, ["id", "kind"]);
      portableId(row.id, "id");
      portableKind(row.kind);
      return;
    case "checkpoint_references":
      exactFields(row, [
        "checkpoint_id",
        "target_id",
        "target_kind",
        "position",
        "snapshot_key",
        "snapshot_title",
        "snapshot_title_json",
      ]);
      portableId(row.checkpoint_id, "checkpoint_id");
      portableId(row.target_id, "target_id");
      portableKind(row.target_kind);
      portableInteger(row.position, "position");
      portableId(row.snapshot_key, "snapshot_key");
      if (decodeText(row, "snapshot_title") === null) {
        invalidRow("snapshot_title");
      }
      return;
    case "checkpoint_acceptances":
      exactFields(row, ["checkpoint_id", "child_session_id", "position"]);
      portableId(row.checkpoint_id, "checkpoint_id");
      portableId(row.child_session_id, "child_session_id");
      portableInteger(row.position, "position");
      return;
    case "task_comments":
      exactFields(row, [
        "id",
        "task_id",
        "title",
        "title_json",
        "body",
        "body_json",
        "created_at",
        "created_by",
        "after_id",
      ]);
      decodePortableComment(row);
      return;
    case "replication_entity_versions":
      exactFields(row, ["entity_id", "version", "parents_json"]);
      portableId(row.entity_id, "entity_id");
      portableVersion(row.version, "version");
      portableParents(portableJson(row.parents_json, "parents_json"));
      return;
    case "batch_receipts":
      exactFields(row, ["operation_key", "request_json", "result_json"]);
      decodePortableReceipt(row);
      return;
    case "replication_confirmations":
      exactFields(row, ["replica_id", "ranges_json", "proofs_json"]);
      decodePortableConfirmation(row);
      return;
    case "replication_publications":
      exactFields(row, ["id", "payload_json"]);
      decodePortablePublication(
        portableId(row.id, "id"),
        identityText(row.payload_json, "payload_json"),
      );
      return;
    default:
      invalidRow(name);
  }
}
