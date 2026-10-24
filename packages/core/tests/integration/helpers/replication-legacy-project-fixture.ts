import { Database } from "bun:sqlite";
import type { EntityRecord, PortableBatchReceipt } from "@relay/contracts";
import { batchUpgradeV1Schema } from "../../../../storage/tests/integration/helpers/batch-receipt-v1-schema";
import { BATCH_RECEIPT_SCHEMA } from "../../../../storage/src/sqlite/batch-schema";

/**
 * Создаёт реальную v2 SQLite на замороженной исторической схеме с заданными raw агрегатами/receipts.
 * Текущую миграцию выполняет последующий публичный ProjectDatabase.open; helper закрывает своё
 * соединение, а каталог и удаление файла принадлежат вызывающей replication fixture.
 */
export function createLegacyReplicationProject(
  path: string,
  projectId: string,
  records: readonly EntityRecord[],
  receipts: readonly PortableBatchReceipt[],
): void {
  const raw = new Database(path, { create: true, strict: true });
  try {
    raw.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; BEGIN IMMEDIATE");
    raw.exec(batchUpgradeV1Schema);
    raw.exec(BATCH_RECEIPT_SCHEMA);
    raw.exec("PRAGMA application_id = 0x524c5932; PRAGMA user_version = 2");
    raw.query("INSERT INTO project_state VALUES(1,?,0)").run(projectId);
    const insert = raw.query("INSERT INTO entities VALUES(?,?,?,?,?,?,?,?,?)");
    for (const record of records) {
      const { comments: _comments, ...data } = record.data;
      insert.run(
        record.id,
        record.kind,
        record.key,
        record.revision,
        record.createdAt,
        record.updatedAt,
        record.createdBy,
        record.updatedBy,
        JSON.stringify(data),
      );
    }
    const receiptInsert = raw.query("INSERT INTO batch_receipts VALUES(?,?,?)");
    for (const receipt of receipts) {
      receiptInsert.run(receipt.operationKey, receipt.requestJson, receipt.resultJson);
    }
    raw.exec("COMMIT");
  } finally {
    if (raw.inTransaction) {
      raw.exec("ROLLBACK");
    }
    raw.close();
  }
}
