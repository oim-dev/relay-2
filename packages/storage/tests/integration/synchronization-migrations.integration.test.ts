import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { ProjectDatabase } from "../../src/database/project-database";
import {
  ProjectDatabaseFixture,
  createDocument,
  expectRelayError,
} from "./helpers/project-database-fixture";

const queueCases = [
  { name: "непустая очередь changeset", pending: true, dirtySince: 0 },
  { name: "подтверждённая пустая очередь", pending: false, dirtySince: null },
] as const;
let fixture: ProjectDatabaseFixture;

/**
 * Воспроизводит v4 удалением единственного добавления v5 — таблицы расписания.
 * Вызывающий закрывает ProjectDatabase до преобразования. Явная проверка исходной
 * версии не позволяет молча использовать этот fixture после следующей смены схемы.
 */
function removeV5Schedule(): void {
  fixture.withRaw((raw) => {
    expect(raw.query("PRAGMA user_version").get()).toEqual({ user_version: 5 });
    raw.exec("DROP TABLE synchronization_schedule; PRAGMA user_version=4");
  });
}

beforeEach(() => {
  fixture = new ProjectDatabaseFixture("schedule-migration", "project-local-sync/storage-review");
});

afterEach(() => {
  fixture.close();
});

describe("Добавление расписания в файловую схему v4", () => {
  test.each(queueCases)(
    "$name сохраняется без переписывания истории и получает расписание после reopen",
    ({ pending, dirtySince }) => {
      const db = fixture.create();
      const document = createDocument();
      const receipt = {
        operationKey: "before-v5",
        requestJson: "{}",
        resultJson: '{"revision":7}',
      };
      db.transaction(() => {
        db.insert(document);
        db.insertBatchReceipt(receipt);
      });
      db.rename(document.id, "DOC-RENAMED", document.revision, "author");
      const queue = db.getReplicationOutbox();
      if (!pending) {
        db.updateReplicationState({ conflicts: [], acknowledged: queue.map((entry) => entry.id) });
      }
      const snapshot = db.captureReplication();
      const state = db.getReplicationState();
      const generation = db.getGeneration();
      db.close();
      removeV5Schedule();
      // Воссоздаём исходные sources с пробелами исторического писателя: UPDATE запрещён
      // immutable guard. Миграция не должна пересериализовать даже такие валидные bytes.
      fixture.withRaw((raw) => {
        for (const change of pending ? queue : []) {
          raw
            .query("INSERT OR REPLACE INTO replication_outbox VALUES(?,?,?)")
            .run(change.id, change.sequence, JSON.stringify(change, null, 1));
        }
      });
      const bytes = fixture.withRaw((raw) =>
        raw.query("SELECT * FROM replication_outbox ORDER BY sequence").all(),
      );
      const structure = fixture.withRaw((raw) =>
        raw.query("SELECT name,sql FROM sqlite_schema ORDER BY name").all(),
      );

      const migrated = fixture.open();
      const schedule = migrated.getSynchronizationSchedule();

      expect(schedule).toEqual({
        mode: "auto",
        dirtySince,
        lastMutationAt: dirtySince,
        nextAttemptAt: 0,
        lastAttemptAt: null,
        failures: 0,
      });
      expect(migrated.captureReplication()).toEqual(snapshot);
      expect(migrated.getReplicationState()).toEqual(state);
      expect(migrated.getGeneration()).toBe(generation);
      expect(migrated.get(document.key)?.key).toBe("DOC-RENAMED");
      expect(migrated.getBatchReceipt(receipt.operationKey)).toEqual(receipt);
      expect(migrated.getReplicationOutbox()).toEqual(pending ? queue : []);
      fixture.withRaw((raw) => {
        expect(raw.query("PRAGMA user_version").get()).toEqual({ user_version: 5 });
        expect(raw.query("SELECT * FROM replication_outbox ORDER BY sequence").all()).toEqual(
          bytes,
        );
        expect(
          raw
            .query(
              "SELECT name,sql FROM sqlite_schema WHERE tbl_name!='synchronization_schedule' ORDER BY name",
            )
            .all(),
        ).toEqual(structure);
      });
      migrated.close();

      const reopened = fixture.open();

      expect(reopened.getSynchronizationSchedule()).toEqual(schedule);
      expect(reopened.getReplicationState()).toEqual(state);
      expect(reopened.getReplicationOutbox()).toEqual(pending ? queue : []);
    },
  );

  test("отказ инициализации расписания откатывает его DDL и версию, повторное открытие сохраняет pending", () => {
    const db = fixture.create();
    const queue = db.getReplicationOutbox();
    const state = db.getReplicationState();
    db.close();
    removeV5Schedule();
    // Таблица расписания создастся, но INSERT её первой строки не сможет прочитать outbox.
    fixture.withRaw((raw) =>
      raw.exec("ALTER TABLE replication_outbox RENAME TO unavailable_outbox"),
    );
    const structure = fixture.withRaw((raw) =>
      raw.query("SELECT name,sql FROM sqlite_schema ORDER BY name").all(),
    );

    const failure = expectRelayError(() => fixture.open(), "STORAGE_ERROR");

    expect(failure.details).toMatchObject({ reason: "no such table: replication_outbox" });
    fixture.withRaw((raw) => {
      expect(raw.query("PRAGMA user_version").get()).toEqual({ user_version: 4 });
      expect(raw.query("SELECT name,sql FROM sqlite_schema ORDER BY name").all()).toEqual(
        structure,
      );
      raw.exec("ALTER TABLE unavailable_outbox RENAME TO replication_outbox");
    });

    const retried = fixture.open();

    expect(retried.getReplicationOutbox()).toEqual(queue);
    expect(retried.getReplicationState()).toEqual(state);
    expect(retried.getSynchronizationSchedule()).toEqual({
      mode: "auto",
      dirtySince: 0,
      lastMutationAt: 0,
      nextAttemptAt: 0,
      lastAttemptAt: null,
      failures: 0,
    });
  });

  test("readonly не мигрирует v4 и не меняет её очередь", () => {
    const db = fixture.create();
    const queue = db.getReplicationOutbox();
    db.close();
    removeV5Schedule();

    const failure = expectRelayError(() => {
      const unexpected = ProjectDatabase.openReadonly(fixture.path);
      unexpected.close();
    }, "SCHEMA_VERSION_UNSUPPORTED");

    expect(failure.details).toMatchObject({ expectedVersion: 5, actualVersion: 4 });
    fixture.withRaw((raw) => {
      expect(raw.query("PRAGMA user_version").get()).toEqual({ user_version: 4 });
      expect(
        raw.query("SELECT name FROM sqlite_schema WHERE name='synchronization_schedule'").all(),
      ).toEqual([]);
    });
    expect(fixture.open().getReplicationOutbox()).toEqual(queue);
  });
});
