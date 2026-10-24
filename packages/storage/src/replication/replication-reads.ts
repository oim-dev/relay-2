import type { Database } from "bun:sqlite";
import type { ReplicationReadGuard } from "@relay/contracts";

/**
 * Фиксирует лишь реально прочитанные ID в текущем write-UOW одним узким SQL-запросом.
 * Вложенные savepoint откатывают основания; создание внутри текущей транзакции не образует self-dependency.
 * Адресные проверки зависят от создания ID, а чтения содержания — от последней локальной версии.
 */
export function observeReplicationReads(
  connection: Database,
  ids: readonly string[],
  kind: ReplicationReadGuard["kind"],
): void {
  const prefix = kind === "content" ? "entity:" : "existence:";
  connection
    .query(
      `INSERT OR IGNORE INTO replication_read_queue(owner,entity_id,record_kind,version,changeset_id)
    SELECT ? || requested.value,requested.value,?,CASE WHEN ?='content' THEN v.version ELSE NULL END,h.changeset_id FROM json_each(?) requested
    LEFT JOIN replication_entity_versions v ON v.entity_id=requested.value
    LEFT JOIN replication_owner_heads h ON h.owner=? || requested.value`,
    )
    .run(prefix, kind, kind, JSON.stringify(ids), prefix);
}
