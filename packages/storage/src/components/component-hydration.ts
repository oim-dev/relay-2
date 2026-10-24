import type { Database } from "bun:sqlite";
import {
  assembleComponentRecord,
  type EntityRecord,
  type PortableComponent,
} from "@relay/contracts";
import { decodeComponentRow } from "./component-store";
import type { ComponentRow } from "./component-store.types";

/**
 * Гидратирует только выбранное окно owners одним пакетным чтением действующих payload частей.
 * Адреса, tombstones и чужие owners не загружаются; повторы владельца переиспользуют один индекс.
 * Снимок удерживает вызывающий ProjectDatabase/command adapter.
 */
export function hydrateComponentRecords(
  connection: Database,
  records: readonly EntityRecord[],
): EntityRecord[] {
  if (records.length === 0) {
    return [];
  }
  const ids = [...new Set(records.map((record) => record.id))];
  const rows = connection
    .query<ComponentRow, [string]>(
      `SELECT * FROM entity_components
    WHERE owner_id IN (SELECT value FROM json_each(?)) AND deleted=0 AND kind!='address-assignment'`,
    )
    .all(JSON.stringify(ids));
  const byOwner = new Map<string, PortableComponent[]>();
  for (const row of rows) {
    const entries = byOwner.get(row.owner_id) ?? [];
    entries.push(decodeComponentRow(row));
    byOwner.set(row.owner_id, entries);
  }
  return records.map((record) => assembleComponentRecord(record, byOwner.get(record.id) ?? []));
}
