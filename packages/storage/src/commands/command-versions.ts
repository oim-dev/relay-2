import type { Database } from "bun:sqlite";
import { RelayError, type CommandEntityVersions } from "@relay/contracts";
import { portableAggregateVersion } from "../replication/portable-version";
import type { PortableAggregatePart } from "../replication/replication.types";
import type { CommandRecordVersionRow } from "./command-versions.types";
import { commandStorageMessages } from "./command.messages";

/**
 * Читает версии выбранных владельцев двумя пакетными SQL-запросами в снимке вызывающего.
 * Выбираются только primary version и scoped ID/version всех частей, включая tombstones и адреса.
 * Тела карточек/частей и комментарии не читаются. Пустой пакет не обращается к SQL.
 * Отсутствие версии уже выбранного владельца считается повреждением, а не новым пустым токеном.
 */
export function readCommandVersions(
  connection: Database,
  ids: readonly string[],
): Readonly<Record<string, CommandEntityVersions>> {
  if (ids.length === 0) {
    return {};
  }
  const requested = JSON.stringify([...new Set(ids)]);
  const roots = connection
    .query<CommandRecordVersionRow, [string]>(
      `
    SELECT requested.value AS id,v.version AS recordVersion FROM json_each(?) requested
    LEFT JOIN replication_entity_versions v ON v.entity_id=requested.value
  `,
    )
    .all(requested);
  const parts = connection
    .query<PortableAggregatePart, [string]>(
      `
    SELECT owner_id AS ownerId,kind,id,version FROM entity_components
    WHERE owner_id IN (SELECT value FROM json_each(?))
  `,
    )
    .all(requested);
  const byOwner = new Map<string, PortableAggregatePart[]>();
  for (const part of parts) {
    const entries = byOwner.get(part.ownerId) ?? [];
    entries.push(part);
    byOwner.set(part.ownerId, entries);
  }
  return Object.fromEntries(
    roots.map(({ id, recordVersion }) => {
      if (recordVersion === null || recordVersion.length === 0) {
        throw new RelayError("CORRUPT_DATA", commandStorageMessages.versionMissing, 1, { id });
      }
      return [
        id,
        {
          recordVersion,
          aggregateVersion: portableAggregateVersion(
            { record: { id }, version: recordVersion },
            byOwner.get(id) ?? [],
          ),
        },
      ] as const;
    }),
  );
}
