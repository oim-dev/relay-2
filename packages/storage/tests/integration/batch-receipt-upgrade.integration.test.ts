import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import type { StoredBatchReceipt } from "../../src/batch/batch-receipt.types";
import { ProjectDatabase } from "../../src/database/project-database";
import {
  BatchReceiptUpgradeFixture,
  batchUpgradeGeneration,
} from "./helpers/batch-receipt-upgrade-fixture";
import { componentTask } from "./helpers/components-fixture";
import {
  ProjectDatabaseFixture,
  createComment,
  createDocument,
  expectRelayError,
  requireRecord,
} from "./helpers/project-database-fixture";

const receipt: StoredBatchReceipt = {
  operationKey: "publish-receipt",
  requestJson: '{"actor":"agent","input":{"version":1}}',
  resultJson: '{"status":"committed","original":"Первоначальная квитанция"}',
};
const rejectedDatabases = [
  {
    name: "историческая схема v1",
    corrupt: "",
    expectedCode: "SCHEMA_VERSION_UNSUPPORTED",
    expectedVersion: 1,
  },
  {
    name: "чужой application_id",
    corrupt: "PRAGMA application_id = 42",
    expectedCode: "DATABASE_INVALID",
    expectedVersion: 1,
  },
  {
    name: "неизвестная будущая версия схемы",
    corrupt: "PRAGMA user_version = 7",
    expectedCode: "SCHEMA_VERSION_UNSUPPORTED",
    expectedVersion: 7,
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
    triggerBody: "INSERT INTO receipt_commit_guard VALUES ('missing-receipt');",
    expectedReason: "FOREIGN KEY constraint failed",
    insertionCompleted: true,
  },
] as const;

describe("Отказ открытия несовместимой файловой базы", () => {
  let fixture: BatchReceiptUpgradeFixture;

  beforeEach(() => {
    fixture = new BatchReceiptUpgradeFixture();
  });

  afterEach(() => {
    fixture.close();
  });

  for (const method of ["open", "openReadonly"] as const) {
    test.each(rejectedDatabases)(
      `${method}: $name отклоняется до включения WAL и сохраняет заполненный файл`,
      ({ corrupt, expectedCode, expectedVersion }) => {
        fixture.createV1();
        fixture.withRaw((raw) => {
          // DELETE позволяет обнаружить даже переключение режима журнала перед отказом.
          raw.exec("PRAGMA journal_mode = DELETE");
          if (corrupt) {
            raw.exec(corrupt);
          }
          expect(raw.query("PRAGMA foreign_key_check").all()).toEqual([]);
        });
        const before = readFileSync(fixture.path);
        expect(readdirSync(fixture.directory)).toEqual(["project.sqlite"]);

        const failure = expectRelayError(() => {
          const unexpected = ProjectDatabase[method](fixture.path);
          unexpected.close();
        }, expectedCode);

        if (expectedCode === "SCHEMA_VERSION_UNSUPPORTED") {
          expect(failure.details).toMatchObject({
            expectedVersion: 6,
            actualVersion: expectedVersion,
          });
        }
        expect(readFileSync(fixture.path)).toEqual(before);
        expect(readdirSync(fixture.directory)).toEqual(["project.sqlite"]);
        fixture.withRaw((raw) => {
          expect(raw.query("PRAGMA user_version").get()).toEqual({
            user_version: expectedVersion,
          });
          expect(raw.query("PRAGMA journal_mode").get()).toEqual({ journal_mode: "delete" });
          expect(raw.query("SELECT * FROM project_state").get()).toEqual({
            singleton: 1,
            project_id: "legacy-project",
            generation: batchUpgradeGeneration,
          });
          expect(
            raw.query("SELECT name FROM sqlite_schema WHERE tbl_name = 'batch_receipts'").all(),
          ).toEqual([]);
        });
      },
    );
  }

  test("не-SQLite файл отклоняется без замены его содержимого", () => {
    writeFileSync(fixture.path, "Повреждённый заголовок SQLite\nСодержимое необходимо сохранить.");
    const before = readFileSync(fixture.path);

    const failure = expectRelayError(() => fixture.open(), "STORAGE_ERROR");

    expect(failure.cause).toMatchObject({ code: "SQLITE_NOTADB" });
    expect(readFileSync(fixture.path)).toEqual(before);
    expect(readdirSync(fixture.directory)).toEqual(["project.sqlite"]);
  });
});

describe("Состояние базы и атомарность квитанции в текущей схеме", () => {
  let fixture: ProjectDatabaseFixture;

  beforeEach(() => {
    fixture = new ProjectDatabaseFixture("receipt-rollback", "database-redesign");
  });

  afterEach(() => {
    fixture.close();
  });

  test("отсутствующий project_state отклоняется без восстановления строки и включения WAL", () => {
    fixture.create().close();
    fixture.withRaw((raw) => raw.exec("DELETE FROM project_state; PRAGMA journal_mode=DELETE"));
    const before = readFileSync(fixture.path);

    expectRelayError(() => fixture.open(), "DATABASE_INVALID");

    expect(readFileSync(fixture.path)).toEqual(before);
    expect(readdirSync(fixture.directory)).toEqual(["project.sqlite"]);
  });

  test.each(receiptFailures)(
    "$name откатывает данные, журнал, алиасы, счётчики и outbox после повторного открытия",
    ({ triggerBody, expectedReason, insertionCompleted }) => {
      const db = fixture.create();
      const originalDocument = createDocument(db.nextKey("DOC"));
      db.insert(originalDocument);
      const document = db.rename(originalDocument.id, "DOC-CURRENT", 1, "editor");
      const task = componentTask("receipt-task", "TASK-1", []);
      task.data.boardId = requireRecord(db, "BOARD-PRODUCT").id;
      db.insert(task);
      db.appendTaskComment(task.id, createComment("Сохранённое сообщение"));
      const previousReceipt = { ...receipt, operationKey: "previous-operation" };
      db.insertBatchReceipt(previousReceipt);
      const records = db.list();
      const snapshot = db.captureReplication();
      const generation = db.getGeneration();
      const queue = db.getReplicationOutbox();
      const state = db.getReplicationState();
      const schedule = db.getSynchronizationSchedule();
      const counters = fixture.withRaw((raw) =>
        raw.query("SELECT prefix, value FROM key_counters ORDER BY prefix").all(),
      );
      const candidate = createDocument("DOC-2");
      const comment = createComment("Этот комментарий должен откатиться");
      let receiptInserted = false;
      // Собственный отложенный FK внедряет отказ именно COMMIT, независимо от layout проекта.
      fixture.withRaw((raw) =>
        raw.exec(`
          CREATE TABLE receipt_commit_guard (
            operation_key TEXT PRIMARY KEY REFERENCES batch_receipts(operation_key)
              DEFERRABLE INITIALLY DEFERRED
          ) STRICT;
          CREATE TRIGGER reject_receipt AFTER INSERT ON batch_receipts
          WHEN NEW.operation_key = 'publish-receipt' BEGIN ${triggerBody} END;
        `),
      );

      const failure = expectRelayError(
        () =>
          db.transaction(() => {
            expect(db.nextKey("DOC")).toBe(candidate.key);
            db.insert(candidate);
            db.rename(document.id, "DOC-FAILED", document.revision, "editor");
            db.appendTaskComment(task.id, comment);
            db.insertBatchReceipt(receipt);
            receiptInserted = true;
          }),
        "CONFLICT",
      );

      expect(failure.details).toMatchObject({ reason: expectedReason });
      expect(receiptInserted).toBe(insertionCompleted);
      db.close();
      const reopened = fixture.open();
      expect(reopened.list()).toEqual(records);
      expect(reopened.captureReplication()).toEqual(snapshot);
      expect(reopened.get(originalDocument.key)).toEqual(document);
      expect(reopened.get(candidate.id)).toBeUndefined();
      expect(reopened.get(candidate.key)).toBeUndefined();
      expect(reopened.get("DOC-FAILED")).toBeUndefined();
      expect(reopened.getBatchReceipt(receipt.operationKey)).toBeUndefined();
      expect(reopened.getBatchReceipt(previousReceipt.operationKey)).toEqual(previousReceipt);
      expect(reopened.getGeneration()).toBe(generation);
      expect(reopened.getReplicationOutbox()).toEqual(queue);
      expect(reopened.getReplicationState()).toEqual(state);
      expect(reopened.getSynchronizationSchedule()).toEqual(schedule);
      fixture.withRaw((raw) => {
        expect(raw.query("SELECT prefix, value FROM key_counters ORDER BY prefix").all()).toEqual(
          counters,
        );
        expect(raw.query("SELECT * FROM receipt_commit_guard").all()).toEqual([]);
        raw.exec("DROP TRIGGER reject_receipt");
      });
      expect(reopened.nextKey("DOC")).toBe(candidate.key);
      reopened.insertBatchReceipt(receipt);
      expect(reopened.getBatchReceipt(receipt.operationKey)).toEqual(receipt);
      expect(reopened.getGeneration()).toBe(generation);
    },
  );
});
