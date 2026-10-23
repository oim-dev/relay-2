import type { Database } from "bun:sqlite";
import type { StoredBatchReceipt } from "./batch-receipt.types";

/**
 * Читает квитанцию по точному ключу без обращения к текущим сущностям; отсутствие даёт undefined.
 */
export function readBatchReceipt(
  connection: Database,
  key: string,
): StoredBatchReceipt | undefined {
  return (
    connection
      .query<StoredBatchReceipt, [string]>(
        `SELECT operation_key AS operationKey, request_json AS requestJson, result_json AS resultJson
     FROM batch_receipts WHERE operation_key = ?`,
      )
      .get(key) ?? undefined
  );
}

/**
 * Вставляет квитанцию в транзакции вызывающего; занятый ключ отклоняется SQLite без замены.
 * Поколение предметных данных не меняется: квитанция не является сущностью проекта.
 */
export function insertBatchReceipt(connection: Database, receipt: StoredBatchReceipt): void {
  connection
    .query("INSERT INTO batch_receipts(operation_key, request_json, result_json) VALUES (?, ?, ?)")
    .run(receipt.operationKey, receipt.requestJson, receipt.resultJson);
}
