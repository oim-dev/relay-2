import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import type { StoredBatchReceipt } from "../../src/batch/batch-receipt.types";
import type { ProjectDatabase } from "../../src/database/project-database";
import {
  BatchReceiptUpgradeFixture,
  batchUpgradeComments,
  batchUpgradeDocument,
  batchUpgradeGeneration,
  batchUpgradeRecords,
  batchUpgradeTask,
} from "./helpers/batch-receipt-upgrade-fixture";
import {
  createComment,
  createDocument,
  expectRelayError,
} from "./helpers/project-database-fixture";

const receipt: StoredBatchReceipt = {
  operationKey: "publish-upgrade",
  requestJson: '{"actor":"agent","input":{"version":1}}',
  resultJson: '{"status":"committed","original":"Квитанция после миграции"}',
};
const counters = [
  { prefix: "DOC", value: 17 },
  { prefix: "RESERVED", value: 6 },
  { prefix: "TASK", value: 11 },
];
const rejectedDatabases = [
  {
    name: "чужой application_id",
    corrupt: "PRAGMA application_id = 42",
    expectedCode: "DATABASE_INVALID",
    expectedVersion: 1,
  },
  {
    name: "более новая версия схемы",
    corrupt: "PRAGMA user_version = 5",
    expectedCode: "SCHEMA_VERSION_UNSUPPORTED",
    expectedVersion: 5,
  },
  {
    name: "отсутствующая обязательная строка project_state",
    corrupt: "DELETE FROM project_state",
    expectedCode: "DATABASE_INVALID",
    expectedVersion: 1,
  },
] as const;
const receiptFailures = [
  {
    name: "отказ AFTER INSERT квитанции",
    triggerBody: "SELECT RAISE(ABORT, 'fixture: receipt write rejected');",
    expectedReason: "fixture: receipt write rejected",
    insertionCompleted: false,
  },
  {
    name: "отказ COMMIT после успешной вставки квитанции",
    triggerBody: "UPDATE project_state SET project_id = 'missing-project' WHERE singleton = 1;",
    expectedReason: "FOREIGN KEY constraint failed",
    insertionCompleted: true,
  },
] as const;
let fixture: BatchReceiptUpgradeFixture;

/**
 * Проверяет весь исторический набор через публичные чтения, включая отдельный журнал,
 * прежние адреса и поколение; счётчики не расходует и состояние не изменяет.
 */
function expectLegacyRecords(db: ProjectDatabase): void {
  expect(db.projectId).toBe("legacy-project");
  expect(db.count()).toBe(batchUpgradeRecords.length);
  for (const record of batchUpgradeRecords) {
    const expected =
      record.kind === "task"
        ? { ...record, data: { ...record.data, comments: batchUpgradeComments } }
        : record;
    expect(db.get(record.id)).toEqual(expected);
  }
  expect(db.get("DOC-1")).toEqual(batchUpgradeDocument);
  expect(db.get("DOC-4")).toEqual(batchUpgradeDocument);
  expect(db.get("DOC-7")).toEqual(batchUpgradeDocument);
  expect(db.getGeneration()).toBe(batchUpgradeGeneration);
}

beforeEach(() => {
  fixture = new BatchReceiptUpgradeFixture();
});

afterEach(() => {
  fixture.close();
});

describe("Обновление исторической файловой схемы v1 для batch-квитанций", () => {
  test("open и reopen сохраняют исторические данные и добавляют квитанции и нормализованную очередь v4", () => {
    fixture.createV1();
    const legacyComments = fixture.withRaw((raw) => ({
      columns: raw.query<Record<string, unknown>, []>("PRAGMA table_info(task_comments)").all(),
      foreignKeys: raw.query("PRAGMA foreign_key_list(task_comments)").all(),
    }));
    const legacyStructure = fixture.withRaw((raw) => {
      expect(raw.query("PRAGMA user_version").get()).toEqual({ user_version: 1 });
      expect(raw.query("PRAGMA foreign_key_check").all()).toEqual([]);
      expect(
        raw.query("SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name").all(),
      ).toEqual([
        { name: "entities" },
        { name: "entity_refs" },
        { name: "key_counters" },
        { name: "project_state" },
        { name: "task_comments" },
      ]);
      return raw
        .query(
          "SELECT type, name, sql FROM sqlite_schema WHERE type != 'trigger' AND tbl_name != 'entity_refs' AND NOT(type='table' AND name='task_comments') ORDER BY type, name",
        )
        .all();
    });

    const migrated = fixture.open();

    expectLegacyRecords(migrated);
    expect(migrated.getBatchReceipt(receipt.operationKey)).toBeUndefined();
    migrated.insertBatchReceipt(receipt);
    expect(migrated.getGeneration()).toBe(batchUpgradeGeneration);
    migrated.close();
    const reopened = fixture.open();
    expectLegacyRecords(reopened);
    expect(reopened.getBatchReceipt(receipt.operationKey)).toEqual(receipt);
    fixture.withRaw((raw) => {
      expect(raw.query("PRAGMA user_version").get()).toEqual({ user_version: 4 });
      expect(raw.query("PRAGMA foreign_key_check").all()).toEqual([]);
      expect(raw.query("PRAGMA journal_mode").get()).toEqual({ journal_mode: "wal" });
      expect(
        raw
          .query(
            "SELECT type, name, sql FROM sqlite_schema WHERE type != 'trigger' AND tbl_name NOT IN ('batch_receipts','entity_refs','entity_components') AND NOT(type='table' AND name='task_comments') AND tbl_name NOT LIKE 'replication_%' AND tbl_name NOT LIKE 'component_%' AND tbl_name NOT LIKE 'command_%' ORDER BY type, name",
          )
          .all(),
      ).toEqual(legacyStructure);
      expect(
        raw
          .query<Record<string, unknown>, []>("PRAGMA table_info(task_comments)")
          .all()
          .filter((column) => column.name !== "text_encoding"),
      ).toEqual(legacyComments.columns);
      expect(raw.query("PRAGMA foreign_key_list(task_comments)").all()).toEqual(
        legacyComments.foreignKeys,
      );
      expect(raw.query("SELECT DISTINCT text_encoding FROM task_comments").all()).toEqual([
        { text_encoding: 0 },
      ]);
      expect(raw.query("SELECT prefix, value FROM key_counters ORDER BY prefix").all()).toEqual(
        counters,
      );
    });
    expect(reopened.nextKey("DOC")).toBe("DOC-18");
    expect(reopened.nextKey("TASK")).toBe("TASK-12");
    expect(reopened.nextKey("RESERVED")).toBe("RESERVED-7");
    expect(reopened.getGeneration()).toBe(batchUpgradeGeneration);
  });

  test("поздняя коллизия DDL откатывает уже созданные таблицу и триггер до повторного open", () => {
    fixture.createV1();
    // Коллизия последнего DDL возникает после создания batch_receipts и её первого триггера.
    fixture.withRaw((raw) =>
      raw.exec(`
      CREATE TRIGGER batch_receipts_no_delete BEFORE DELETE ON key_counters BEGIN SELECT 1; END;
    `),
    );
    const before = readFileSync(fixture.path);

    const failure = expectRelayError(() => fixture.open(), "STORAGE_ERROR");

    expect(failure.details).toMatchObject({
      reason: "trigger batch_receipts_no_delete already exists",
    });
    expect(readFileSync(fixture.path)).toEqual(before);
    fixture.withRaw((raw) => {
      expect(raw.query("PRAGMA user_version").get()).toEqual({ user_version: 1 });
      expect(
        raw.query("SELECT name FROM sqlite_schema WHERE tbl_name = 'batch_receipts'").all(),
      ).toEqual([]);
      raw.exec("DROP TRIGGER batch_receipts_no_delete");
    });
    const retried = fixture.open();
    expectLegacyRecords(retried);
    retried.insertBatchReceipt(receipt);
    expect(retried.getBatchReceipt(receipt.operationKey)).toEqual(receipt);
  });

  test.each(rejectedDatabases)(
    "$name отклоняется без изменения заполненного файла",
    ({ corrupt, expectedCode, expectedVersion }) => {
      fixture.createV1();
      fixture.withRaw((raw) => raw.exec(corrupt));
      const before = readFileSync(fixture.path);

      expectRelayError(() => fixture.open(), expectedCode);

      expect(readFileSync(fixture.path)).toEqual(before);
      fixture.withRaw((raw) => {
        expect(raw.query("PRAGMA user_version").get()).toEqual({ user_version: expectedVersion });
        expect(
          raw.query("SELECT name FROM sqlite_schema WHERE tbl_name = 'batch_receipts'").all(),
        ).toEqual([]);
      });
    },
  );

  test("не-SQLite файл отклоняется без замены его содержимого", () => {
    writeFileSync(fixture.path, "Повреждённый заголовок SQLite\nСодержимое необходимо сохранить.");
    const before = readFileSync(fixture.path);

    const failure = expectRelayError(() => fixture.open(), "STORAGE_ERROR");

    expect(failure.cause).toMatchObject({ code: "SQLITE_NOTADB" });
    expect(readFileSync(fixture.path)).toEqual(before);
  });
});

describe("Отказ SQLite при сохранении квитанции в мигрированной базе", () => {
  test.each(receiptFailures)(
    "$name откатывает данные, журнал, алиасы и счётчики после reopen",
    ({ triggerBody, expectedReason, insertionCompleted }) => {
      fixture.createV1();
      const db = fixture.open();
      const previousReceipt = { ...receipt, operationKey: "previous-operation" };
      db.insertBatchReceipt(previousReceipt);
      const document = createDocument("DOC-18");
      const comment = createComment("Этот комментарий должен откатиться");
      let receiptInserted = false;
      // Во втором случае отложенный FK допускает INSERT, но запрещает внешний COMMIT.
      fixture.withRaw((raw) =>
        raw.exec(`
      CREATE TRIGGER upgrade_reject_receipt AFTER INSERT ON batch_receipts
      WHEN NEW.operation_key = 'publish-upgrade' BEGIN ${triggerBody} END;
    `),
      );

      const failure = expectRelayError(
        () =>
          db.transaction(() => {
            expect(db.nextKey("DOC")).toBe(document.key);
            db.insert(document);
            db.rename(
              batchUpgradeDocument.id,
              "DOC-FAILED",
              batchUpgradeDocument.revision,
              "editor",
            );
            db.appendTaskComment(batchUpgradeTask.id, comment);
            db.insertBatchReceipt(receipt);
            receiptInserted = true;
          }),
        "CONFLICT",
      );

      expect(failure.details).toMatchObject({ reason: expectedReason });
      expect(receiptInserted).toBe(insertionCompleted);
      db.close();
      const reopened = fixture.open();
      expectLegacyRecords(reopened);
      expect(reopened.get(document.id)).toBeUndefined();
      expect(reopened.get(document.key)).toBeUndefined();
      expect(reopened.get("DOC-FAILED")).toBeUndefined();
      expect(reopened.getBatchReceipt(receipt.operationKey)).toBeUndefined();
      expect(reopened.getBatchReceipt(previousReceipt.operationKey)).toEqual(previousReceipt);
      fixture.withRaw((raw) => {
        expect(raw.query("SELECT prefix, value FROM key_counters ORDER BY prefix").all()).toEqual(
          counters,
        );
        raw.exec("DROP TRIGGER upgrade_reject_receipt");
      });
      expect(reopened.nextKey("DOC")).toBe(document.key);
      reopened.insertBatchReceipt(receipt);
      expect(reopened.getBatchReceipt(receipt.operationKey)).toEqual(receipt);
      expect(reopened.getGeneration()).toBe(batchUpgradeGeneration);
    },
  );
});
