import { batchReceiptMessages } from "../batch/batch-receipt.messages";

/**
 * Добавочная схема v2: журнал первоначальных результатов без TTL и возможности перезаписи.
 * Используется как при создании, так и при технической миграции существующей v1.
 */
export const BATCH_RECEIPT_SCHEMA = `
  CREATE TABLE batch_receipts (
    operation_key TEXT PRIMARY KEY NOT NULL CHECK(length(operation_key) > 0),
    request_json TEXT NOT NULL CHECK(json_valid(request_json) AND json_type(request_json) = 'object'),
    result_json TEXT NOT NULL CHECK(json_valid(result_json) AND json_type(result_json) = 'object')
  ) STRICT;
  CREATE TRIGGER batch_receipts_no_update BEFORE UPDATE ON batch_receipts BEGIN
    SELECT RAISE(ABORT, '${batchReceiptMessages.immutableConstraint}');
  END;
  CREATE TRIGGER batch_receipts_no_delete BEFORE DELETE ON batch_receipts BEGIN
    SELECT RAISE(ABORT, '${batchReceiptMessages.immutableConstraint}');
  END;
`;
