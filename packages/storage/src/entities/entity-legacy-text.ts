import type { Database } from "bun:sqlite";
import { RelayError } from "@relay/contracts";
import { entityMessages } from "./entity.messages";

/**
 * Plain SQL TEXT и JSON carriers прежних схем; имена константны, пользовательский SQL не строится.
 */
const legacyTextColumns: Readonly<Record<string, readonly string[]>> = {
  entities: ["id", "kind", "key", "created_at", "updated_at", "created_by", "updated_by", "data"],
  entity_refs: ["ref", "entity_id"],
  key_counters: ["prefix"],
  project_state: ["project_id"],
  task_comments: ["id", "task_id", "title", "body", "created_at", "created_by"],
  batch_receipts: ["operation_key", "request_json", "result_json"],
  replication_state: ["replica_id", "base_json", "observed_json"],
  replication_outbox: ["id", "json"],
  replication_entity_versions: ["entity_id", "version", "parents_json"],
  replication_conflicts: ["id", "json"],
  replication_decisions: ["id", "json"],
};

/**
 * Проверяет точные исходные bytes до DDL v4. Bun TEXT decoder уже теряет malformed UTF-8,
 * поэтому читаются BLOB; допустимые JSON \uXXXX escapes остаются обычными ASCII bytes.
 * Невозможная сохраняющая миграция даёт CORRUPT_DATA, не исправляет immutable payload/digest.
 */
export function assertLegacyTextEncoding(connection: Database): void {
  const tables = new Set(
    connection
      .query<{ name: string }, []>("SELECT name FROM sqlite_schema WHERE type='table'")
      .all()
      .map((row) => row.name),
  );
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  for (const [table, columns] of Object.entries(legacyTextColumns)) {
    if (!tables.has(table)) {
      continue;
    }
    const projection = columns
      .map((column) => `CAST("${column}" AS BLOB) AS "${column}"`)
      .join(",");
    const rows = connection
      .query<Record<string, Uint8Array | null>, []>(`SELECT ${projection} FROM "${table}"`)
      .iterate();
    for (const row of rows) {
      for (const column of columns) {
        const bytes = row[column];
        if (bytes === null || bytes === undefined) {
          continue;
        }
        try {
          decoder.decode(bytes);
        } catch (cause) {
          const error = new RelayError("CORRUPT_DATA", entityMessages.legacyEncoding, 1, {
            table,
            column,
          });
          error.cause = cause;
          throw error;
        }
      }
    }
  }
}
