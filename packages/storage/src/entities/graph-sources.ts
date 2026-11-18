import type { Database } from "bun:sqlite";
import { RelayError, type EntityRecord } from "@relay/contracts";
import type { EntityRow } from "./entity-queries.types";
import { graphSourceMessages } from "./graph-sources.messages";

/**
 * Читает узкие источники истории либо структурированных связей одним SQL-запросом.
 * Readonly views выбирают только нужные typed колонки без построения полных data/value.
 * Не читает Markdown-тела, журнал задач, критерии, причины участия и итоги сессий.
 * Сканирует metadata всех выбранных owners/parts: объём O(N + E + R), без ограничения размера графа.
 */
export function graphSourceRecords(
  connection: Database,
  view: "history" | "relations",
): EntityRecord[] {
  const source = view === "history" ? "history_graph_sources" : "relation_graph_sources";
  const rows = connection.query<EntityRow, []>(`SELECT * FROM ${source} ORDER BY id`).all();
  return rows.map((row) => {
    const value: unknown = JSON.parse(row.data);
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new RelayError("CORRUPT_DATA", graphSourceMessages.corrupt, 1, { id: row.id });
    }
    return {
      id: row.id,
      kind: row.kind,
      key: row.key,
      revision: row.revision,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      createdBy: row.created_by,
      updatedBy: row.updated_by,
      data: value as Record<string, unknown>,
    };
  });
}
