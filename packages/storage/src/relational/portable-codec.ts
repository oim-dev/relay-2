import {
  componentIdentity,
  type EntityKind,
  type PortableComponent,
  type PortableEntity,
  type PortableEntityRecord,
  type PortableProjectSnapshot,
} from "@relay/contracts";
import { canonicalJson } from "../replication/portable-version";
import { RELATIONAL_TABLES } from "./catalog";
import { encodeText, identityText, invalidRow } from "./columns";
import type { SqlRow } from "./columns.types";
import { decodeComponentRow, encodeComponentRow } from "./component-codec";
import { COMPONENT_DEFINITIONS } from "./component-definitions";
import {
  decodeCheckpointReferences,
  decodeEntityRow,
  encodeCheckpointAcceptances,
  encodeCheckpointReferences,
  encodeEntityRow,
} from "./entity-codec";
import { ENTITY_DEFINITIONS } from "./entity-definitions";
import {
  decodePortableComment,
  decodePortableConfirmation,
  decodePortableReceipt,
} from "./portable-codec-metadata";
import { decodePortablePublication } from "./portable-codec-publication";
import { indexPortableRows, requirePortableRow } from "./portable-codec-relations";
import { decodePortableTableShape } from "./portable-codec-shape";
import type { PortableRowIndex } from "./portable-codec.types";
import { comparePortableText, portableJson, portableParents } from "./portable-codec-values";
import type { PortableTableMap, PortableTableRows } from "./rows.types";

/**
 * Разлагает current model 2 на физические переносимые строки без SQLite I/O и local CAS.
 * Готовые UUID, версии, parents, positions, tombstones и неизменяемые материалы сохраняются.
 * Отсутствующие parents верхнеуровневого владельца означают [] и записываются как JSON-массив.
 * Технические JSON-колонки канонизируются общим canonicalJson; строки внутри receipts дословны.
 * Несогласованные дубли производных полей, адресов либо непереносимые поля дают CORRUPT_DATA.
 * Исходный снимок не меняется; стоимость включает полный проход и каноническую сортировку.
 */
export function snapshotToPortableRows(snapshot: PortableProjectSnapshot): PortableTableRows {
  if (
    snapshot.formatVersion !== 1 ||
    snapshot.modelVersion !== 2 ||
    snapshot.components === undefined ||
    snapshot.publication === undefined
  ) {
    invalidRow("snapshot.modelVersion/publication");
  }
  const tables: Record<string, SqlRow[]> = {};
  for (const table of RELATIONAL_TABLES) {
    if (table.portable) {
      tables[table.name] = [];
    }
  }
  const entities = new Map(snapshot.entities.map(({ record }) => [record.id, record]));
  for (const entity of snapshot.entities) {
    appendRow(tables, "object_ids", { id: entity.record.id, kind: entity.record.kind });
    appendRow(
      tables,
      ENTITY_DEFINITIONS[entity.record.kind].table,
      encodeEntityRow(entity.record, snapshot.projectId),
    );
    appendRow(tables, "replication_entity_versions", {
      entity_id: entity.record.id,
      version: entity.version,
      parents_json: canonicalJson(entity.parents === undefined ? [] : entity.parents),
    });
    if (entity.record.kind === "work-checkpoint") {
      for (const row of encodeCheckpointReferences(entity.record)) {
        appendRow(tables, "checkpoint_references", { ...row });
      }
      for (const row of encodeCheckpointAcceptances(entity.record)) {
        appendRow(tables, "checkpoint_acceptances", { ...row });
      }
    }
  }
  for (const component of snapshot.components) {
    const targetKind =
      component.kind === "task-target" ? entities.get(component.value.targetId)?.kind : undefined;
    const row = encodeComponentRow(component, targetKind);
    if (component.kind === "address-assignment") {
      row.is_current =
        !component.deleted && entities.get(component.ownerId)?.key === component.value.ref ? 1 : 0;
    }
    appendRow(tables, COMPONENT_DEFINITIONS[component.kind].table, row);
  }
  encodeTechnicalRows(snapshot, tables);
  const rows = decodePortableTableShape({ projectId: snapshot.projectId, tables });
  const restored = assemblePortableSnapshot(rows, indexPortableRows(rows));
  if (canonicalJson(canonicalSnapshot(snapshot)) !== canonicalJson(restored)) {
    invalidRow("snapshot.roundtrip");
  }
  return rows;
}

/**
 * Проверяет unknown JSON набор строк и собирает raw snapshot для отдельного full decoder Core.
 * Закрытая форма таблиц/колонок, PK, типизированные FK и matching identity проверяются до DTO.
 * Исторические labels берутся из сохранённых строк, производные поля — из их первичных таблиц.
 * Входные объекты не меняются; повреждение даёт CORRUPT_DATA, никаких SQL-запросов нет.
 */
export function portableRowsToSnapshot(value: unknown): PortableProjectSnapshot {
  const rows = decodePortableTableShape(value);
  return assemblePortableSnapshot(rows, indexPortableRows(rows));
}

/**
 * Дописывает созданную codec строку только в заранее выделенную переносимую таблицу каталога.
 */
function appendRow(
  tables: Record<string, SqlRow[]>,
  name: keyof PortableTableMap,
  row: SqlRow,
): void {
  const entries = tables[name];
  if (entries === undefined) {
    invalidRow(name);
  }
  entries.push(row);
}

/**
 * Разлагает журналы и канонические технические JSON-материалы.
 * Общий canonicalJson стабилизирует байты SQL/Git; requestJson/resultJson остаются строками.
 */
function encodeTechnicalRows(
  snapshot: PortableProjectSnapshot,
  tables: Record<string, SqlRow[]>,
): void {
  for (const entry of snapshot.comments) {
    appendRow(tables, "task_comments", {
      id: entry.comment.id,
      task_id: entry.taskId,
      ...encodeText(entry.comment.title, "title"),
      ...encodeText(entry.comment.body, "body"),
      created_at: entry.comment.createdAt,
      created_by: entry.comment.createdBy,
      after_id: entry.after,
    });
  }
  for (const entry of snapshot.receipts) {
    appendRow(tables, "batch_receipts", {
      operation_key: entry.operationKey,
      request_json: entry.requestJson,
      result_json: entry.resultJson,
    });
  }
  for (const entry of snapshot.confirmations) {
    appendRow(tables, "replication_confirmations", {
      replica_id: entry.replicaId,
      ranges_json: canonicalJson(entry.ranges),
      proofs_json: entry.proofs === undefined ? null : canonicalJson(entry.proofs),
    });
  }
  if (snapshot.publication !== null && snapshot.publication !== undefined) {
    appendRow(tables, "replication_publications", {
      id: snapshot.publication.publicationId,
      payload_json: canonicalJson(snapshot.publication),
    });
  }
}

/**
 * Собирает новый снимок из проверенных первичных строк; массивы верхнего уровня канонизируются.
 */
function assemblePortableSnapshot(
  rows: PortableTableRows,
  index: PortableRowIndex,
): PortableProjectSnapshot {
  const history = historyProjections(rows.tables);
  const entities: PortableEntity[] = [];
  for (const [id, row] of index.entities) {
    const kind = index.kinds.get(id) ?? invalidRow("object_ids.kind");
    const key = index.keys.get(id) ?? invalidRow("object_keys.is_current");
    const version = requirePortableRow(index, "replication_entity_versions", [id]);
    entities.push({
      record: decodeEntityRow(kind, row, key, derivedFields(kind, id, row, index, history)),
      version: identityText(version.version, "version"),
      parents: portableParents(portableJson(version.parents_json, "parents_json")),
    });
  }
  const components: PortableComponent[] = [];
  for (const table of RELATIONAL_TABLES) {
    if (
      table.componentKind !== undefined &&
      table.name !== "local_entity_revisions" &&
      table.name !== "local_comment_sequences"
    ) {
      for (const row of index.tables.get(table.name)?.values() ?? []) {
        components.push(decodeComponentRow(table.componentKind, row));
      }
    }
  }
  const publication = rows.tables.replication_publications[0];
  return canonicalSnapshot({
    formatVersion: 1,
    modelVersion: 2,
    projectId: rows.projectId,
    entities,
    components,
    addresses: rows.tables.object_keys
      .filter((row) => row.deleted === 0)
      .map((row) => ({ ref: row.ref, entityId: row.owner_id })),
    comments: rows.tables.task_comments.map((row) => decodePortableComment({ ...row })),
    receipts: rows.tables.batch_receipts.map((row) => decodePortableReceipt({ ...row })),
    confirmations: rows.tables.replication_confirmations.map((row) =>
      decodePortableConfirmation({ ...row }),
    ),
    publication:
      publication === undefined
        ? null
        : decodePortablePublication(publication.id, publication.payload_json),
  });
}

/**
 * Выводит только поля обратных связей, для которых хранение второго значения создало бы рассогласование.
 */
function derivedFields(
  kind: EntityKind,
  id: string,
  row: Readonly<SqlRow>,
  index: PortableRowIndex,
  history: ReadonlyMap<string, PortableEntityRecord["data"]>,
): PortableEntityRecord["data"] {
  switch (kind) {
    case "application": {
      const board = index.boards.get(id) ?? invalidRow("applications.boardId");
      return { boardId: board.id, prefix: board.prefix };
    }
    case "implementation": {
      const active = index.activeImplementations.has(id);
      if (row.feature_id !== null) {
        return {
          featureId: row.feature_id,
          targetKind: "feature",
          targetId: row.feature_id,
          active,
        };
      }
      const scenario = requirePortableRow(index, "scenarios", [row.scenario_id]);
      return {
        featureId: scenario.feature_id,
        scenarioId: row.scenario_id,
        targetKind: "scenario",
        targetId: row.scenario_id,
        active,
      };
    }
    case "work-session":
      return { currentRunId: index.runs.get(id) ?? null };
    case "work-checkpoint":
      return history.get(id) ?? { references: [], acceptedSessionIds: [] };
    default:
      return {};
  }
}

/**
 * Группирует исторические массивы один раз; их подписи не зависят от текущих сущностей.
 */
function historyProjections(
  tables: PortableTableMap,
): ReadonlyMap<string, PortableEntityRecord["data"]> {
  const references = groupCheckpointRows(tables.checkpoint_references);
  const acceptances = groupCheckpointRows(tables.checkpoint_acceptances);
  const result = new Map<string, PortableEntityRecord["data"]>();
  for (const row of tables.checkpoints) {
    result.set(row.id, {
      references: decodeCheckpointReferences(references.get(row.id) ?? []),
      acceptedSessionIds: [...(acceptances.get(row.id) ?? [])]
        .sort((left, right) => left.position - right.position)
        .map((entry) => entry.child_session_id),
    });
  }
  return result;
}

/**
 * Группирует строки исторической коллекции по владельцу без изменения входного массива.
 */
function groupCheckpointRows<T extends { readonly checkpoint_id: string }>(
  rows: readonly T[],
): Map<string, T[]> {
  const result = new Map<string, T[]>();
  for (const row of rows) {
    const group = result.get(row.checkpoint_id) ?? [];
    group.push(row);
    result.set(row.checkpoint_id, group);
  }
  return result;
}

/**
 * Стабилизирует первичные наборы и обязательные parents их владельцев.
 * Отсутствующие parents означают []; внутренние материалы истории и proof не нормализуются.
 */
function canonicalSnapshot(snapshot: PortableProjectSnapshot): PortableProjectSnapshot {
  return {
    ...snapshot,
    entities: snapshot.entities
      .map((entity) => ({
        ...entity,
        parents: entity.parents === undefined ? [] : entity.parents,
      }))
      .sort((a, b) => comparePortableText(a.record.id, b.record.id)),
    components: [...(snapshot.components ?? [])].sort((a, b) =>
      comparePortableText(componentIdentity(a), componentIdentity(b)),
    ),
    addresses: [...snapshot.addresses].sort((a, b) => comparePortableText(a.ref, b.ref)),
    comments: [...snapshot.comments].sort((a, b) =>
      comparePortableText(a.comment.id, b.comment.id),
    ),
    receipts: [...snapshot.receipts].sort((a, b) =>
      comparePortableText(a.operationKey, b.operationKey),
    ),
    confirmations: [...snapshot.confirmations].sort((a, b) =>
      comparePortableText(a.replicaId, b.replicaId),
    ),
  };
}
