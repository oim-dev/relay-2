import { describe, expect, spyOn, test } from "bun:test";
import { BatchService } from "../../src/batch/batch";
import { withEntityDatabase } from "./helpers/entity-fixture";

describe("Подготовка запроса до транзакции писателя", () => {
  test("проверка каталога после поиска квитанции не сериализует запрос повторно", async () => {
    await withEntityDatabase(async (db) => {
      const load = db.commands.load.bind(db.commands);
      const stringify = JSON.stringify;
      let afterReceiptRead = false;
      let serializationsAfterReceipt = 0;
      const lookup = spyOn(db.commands, "load").mockImplementation(async (request) => {
        const result = await load(request);
        // Настоящий порт завершил read-only поиск receipt; каталог проверяется до commit.
        if (request.selectors.some((selector) => selector.kind === "receipt")) {
          afterReceiptRead = true;
        }
        return result;
      });
      const commit = spyOn(db.commands, "commit");
      const serialize = spyOn(JSON, "stringify").mockImplementation((value, replacer, space) => {
        if (afterReceiptRead) {
          serializationsAfterReceipt++;
        }
        // Разделяем перегрузки JSON.stringify, не меняя переданный replacer.
        if (typeof replacer === "function") {
          return stringify(value, replacer, space);
        }
        return stringify(value, replacer, space);
      });
      let caught: unknown;
      let commitCalls = 0;

      try {
        await new BatchService(db).execute(
          { version: 1, operations: [{ op: "unknown.operation" }] },
          { actor: "author", operationKey: "invalid-operation" },
        );
      } catch (error) {
        caught = error;
      } finally {
        commitCalls = commit.mock.calls.length;
        serialize.mockRestore();
        lookup.mockRestore();
        commit.mockRestore();
      }

      expect(caught).toMatchObject({
        code: "INVALID_ARGUMENT",
        details: { index: 0, op: "unknown.operation", path: "operations[0].op" },
      });
      expect(afterReceiptRead).toBe(true);
      expect(serializationsAfterReceipt).toBe(0);
      expect(commitCalls).toBe(0);
    });
  });
});
