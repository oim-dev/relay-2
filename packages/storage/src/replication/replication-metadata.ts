import type { Database } from "bun:sqlite";
import type { PortableProjectSnapshot, ReplicationPublication } from "@relay/contracts";
import type { ReplicationConfirmationRow } from "./replication.types";
import type { PortablePublicationRow } from "../relational/rows.types";
import { decodePortablePublication } from "../relational/portable-codec-publication";
import { requireRelationalTransaction } from "../relational/sql-write";
import { canonicalJson } from "./portable-version";

/**
 * Читает принятые подтверждения из их первичных переносимых строк, не из копии base snapshot.
 * Отсутствующий proofs_json сохраняет отсутствие optional proofs в исходном контракте.
 */
export function readReplicationConfirmations(
  connection: Database,
): PortableProjectSnapshot["confirmations"] {
  return connection
    .query<ReplicationConfirmationRow, []>(
      "SELECT replica_id,ranges_json,proofs_json FROM replication_confirmations ORDER BY replica_id",
    )
    .all()
    .map((row) => ({
      replicaId: row.replica_id,
      ranges: JSON.parse(row.ranges_json),
      ...(row.proofs_json === null ? {} : { proofs: JSON.parse(row.proofs_json) }),
    }));
}

/**
 * Читает proof именно текущих переносимых строк, а не последнего принятого checkpoint.
 * Отсутствие строки означает отсутствие доказательства; повреждённая форма даёт CORRUPT_DATA.
 * Вызывающий удерживает общий snapshot с предметными чтениями; полного хеширования проекта здесь нет.
 */
export function readCurrentPublication(connection: Database): ReplicationPublication | null {
  const row = connection
    .query<PortablePublicationRow, []>("SELECT id,payload_json FROM replication_publications")
    .get();
  return row === null ? null : decodePortablePublication(row.id, row.payload_json);
}

/**
 * Снимает утративший актуальность proof в транзакции мутации; base_json не меняет.
 * Возвращает признак удаления строки. Отсутствие proof — no-op; rollback/savepoint восстанавливает его.
 * Поколением и transport guard владеет вызвавшая мутация либо writeReplicationState.
 */
export function invalidateCurrentPublication(connection: Database): boolean {
  requireRelationalTransaction(connection);
  return connection.query("DELETE FROM replication_publications").run().changes > 0;
}

/**
 * Материализует подтверждения проверенного snapshot в транзакции вызывающего.
 * Они входят в snapshotDigest: фактическое изменение снимает прежний current proof, но не base_json.
 * Возвращает признак изменения; no-op не переписывает строки, outbox и поколение не создаются.
 */
export function writeReplicationConfirmations(
  connection: Database,
  confirmations: PortableProjectSnapshot["confirmations"],
): boolean {
  requireRelationalTransaction(connection);
  let changes = connection
    .query(
      "DELETE FROM replication_confirmations WHERE replica_id NOT IN (SELECT value FROM json_each(?))",
    )
    .run(JSON.stringify(confirmations.map((entry) => entry.replicaId))).changes;
  const upsert = connection.query(
    `INSERT INTO replication_confirmations(replica_id,ranges_json,proofs_json) VALUES(?,?,?)
     ON CONFLICT(replica_id) DO UPDATE SET
       ranges_json=excluded.ranges_json,proofs_json=excluded.proofs_json
     WHERE replication_confirmations.ranges_json IS NOT excluded.ranges_json
       OR replication_confirmations.proofs_json IS NOT excluded.proofs_json`,
  );
  for (const entry of confirmations) {
    changes += upsert.run(
      entry.replicaId,
      canonicalJson(entry.ranges),
      entry.proofs === undefined ? null : canonicalJson(entry.proofs),
    ).changes;
  }
  if (changes > 0) {
    invalidateCurrentPublication(connection);
  }
  return changes > 0;
}

/**
 * Назначает доказанно соответствующую текущим строкам публикацию либо снимает её через null.
 * Core проверяет связь с данными под guard; функция не перечитывает и не хеширует проект.
 * Возвращает признак изменения для transport guard. Повтор не выполняет UPDATE/DELETE/INSERT строки.
 * JSON-значения канонизируются общим codec, вложенные requestJson/resultJson остаются точными строками.
 */
export function writeCurrentPublication(
  connection: Database,
  publication: ReplicationPublication | null,
): boolean {
  requireRelationalTransaction(connection);
  if (publication === null) {
    return invalidateCurrentPublication(connection);
  }
  const removed = connection
    .query("DELETE FROM replication_publications WHERE id!=?")
    .run(publication.publicationId).changes;
  const stored = connection
    .query(
      `INSERT INTO replication_publications(id,payload_json) VALUES(?,?)
       ON CONFLICT(id) DO UPDATE SET payload_json=excluded.payload_json
       WHERE replication_publications.payload_json!=excluded.payload_json`,
    )
    .run(publication.publicationId, canonicalJson(publication)).changes;
  return removed + stored > 0;
}
