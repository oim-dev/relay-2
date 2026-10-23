import { describe, expect, spyOn, test } from "bun:test";
import { BatchService } from "../../src/batch/batch";
import { withEntityDatabase } from "./helpers/entity-fixture";

describe("Подготовка запроса до транзакции писателя", () => {
  test("проверка каталога после поиска квитанции не сериализует запрос повторно", () => {
    withEntityDatabase((db) => {
      const readReceipt = db.getBatchReceipt.bind(db);
      const stringify = JSON.stringify;
      let afterReceiptRead = false;
      let serializationsUnderWriter = 0;
      const lookup = spyOn(db, "getBatchReceipt").mockImplementation((key) => {
        const result = readReceipt(key);
        // Эта граница достигается внутри настоящей writer-транзакции BatchService.
        afterReceiptRead = true;
        return result;
      });
      const serialize = spyOn(JSON, "stringify").mockImplementation((value, replacer, space) => {
        if (afterReceiptRead) {
          serializationsUnderWriter++;
        }
        // Разделяем перегрузки JSON.stringify, не меняя переданный replacer.
        if (typeof replacer === "function") {
          return stringify(value, replacer, space);
        }
        return stringify(value, replacer, space);
      });
      let caught: unknown;

      try {
        new BatchService(db).execute(
          { version: 1, operations: [{ op: "unknown.operation" }] },
          { actor: "author", operationKey: "invalid-operation" },
        );
      } catch (error) {
        caught = error;
      } finally {
        serialize.mockRestore();
        lookup.mockRestore();
      }

      expect(caught).toMatchObject({
        code: "INVALID_ARGUMENT",
        details: { index: 0, op: "unknown.operation", path: "operations[0].op" },
      });
      expect(afterReceiptRead).toBe(true);
      expect(serializationsUnderWriter).toBe(0);
    });
  });
});
