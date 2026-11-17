import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { ProjectDatabase } from "../../src/database/project-database";
import { ProjectDatabaseFixture, expectRelayError } from "./helpers/project-database-fixture";

const modeCases = [
  { name: "auto", mode: "auto" },
  { name: "manual", mode: "manual" },
] as const;
let fixture: ProjectDatabaseFixture;

beforeEach(() => {
  fixture = new ProjectDatabaseFixture("mode", "dev-mode-test-review/storage-fixtures");
});

afterEach(() => {
  fixture.close();
});

describe("Локальный auto/manual без подключения транспорта", () => {
  test("переключение в обе стороны переживает reopen без outbox, generation и сброса расписания", () => {
    const db = fixture.create();
    db.completeSynchronizationAttempt({ at: 1_000, nextAttemptAt: 5_000, failed: true });
    const schedule = db.getSynchronizationSchedule();
    const guard = db.getReplicationGuard();
    const outbox = db.getReplicationOutbox();
    const snapshot = db.captureReplication();
    expect(schedule.mode).toBe("auto");

    db.setSynchronizationMode("manual");
    db.close();
    const reopened = fixture.open();

    expect(reopened.getSynchronizationSchedule()).toEqual({ ...schedule, mode: "manual" });
    expect(reopened.getReplicationGuard()).toEqual(guard);
    expect(reopened.getReplicationOutbox()).toEqual(outbox);
    expect(reopened.captureReplication()).toEqual(snapshot);

    reopened.setSynchronizationMode("auto");
    reopened.close();
    const restoredAuto = fixture.open();

    expect(restoredAuto.getSynchronizationSchedule()).toEqual(schedule);
    expect(restoredAuto.getReplicationGuard()).toEqual(guard);
    expect(restoredAuto.getReplicationOutbox()).toEqual(outbox);
    expect(restoredAuto.captureReplication()).toEqual(snapshot);
  });

  test.each(modeCases)(
    "повтор $name не пишет строку расписания и не порождает echo",
    ({ mode }) => {
      const db = fixture.create();
      db.setSynchronizationMode(mode);
      const schedule = db.getSynchronizationSchedule();
      const guard = db.getReplicationGuard();
      const outbox = db.getReplicationOutbox();
      // Реальный SQLite trigger обнаружит даже UPDATE тем же значением: no-op не должен писать строку.
      fixture.withRaw((raw) =>
        raw.exec(`CREATE TRIGGER forbid_schedule_update
      BEFORE UPDATE ON synchronization_schedule
      BEGIN SELECT RAISE(ABORT, 'fixture: no-op wrote schedule'); END`),
      );

      db.setSynchronizationMode(mode);

      expect(db.getSynchronizationSchedule()).toEqual(schedule);
      expect(db.getReplicationGuard()).toEqual(guard);
      expect(db.getReplicationOutbox()).toEqual(outbox);
    },
  );

  test("rollback внешней транзакции отменяет смену режима вместе с новой квитанцией после reopen", () => {
    const db = fixture.create();
    const observer = fixture.open();
    const schedule = db.getSynchronizationSchedule();
    const guard = db.getReplicationGuard();
    const outbox = db.getReplicationOutbox();
    const receipt = { operationKey: "rolled-back-mode", requestJson: "{}", resultJson: "{}" };
    const failure = new Error("fixture: rollback local policy");

    expect(() =>
      db.transaction(() => {
        db.setSynchronizationMode("manual");
        db.insertBatchReceipt(receipt);
        expect(db.getSynchronizationSchedule().mode).toBe("manual");
        expect(observer.getSynchronizationSchedule().mode).toBe("auto");
        throw failure;
      }),
    ).toThrow(failure);
    observer.close();
    db.close();
    const reopened = fixture.open();

    expect(reopened.getSynchronizationSchedule()).toEqual(schedule);
    expect(reopened.getBatchReceipt(receipt.operationKey)).toBeUndefined();
    expect(reopened.getReplicationGuard()).toEqual(guard);
    expect(reopened.getReplicationOutbox()).toEqual(outbox);
  });

  test("bootstrap не заменяет локальный manual режимом источника и не создаёт echo", () => {
    const source = fixture.create();
    const snapshot = source.captureReplication();
    const replica = ProjectDatabase.createReplica(
      join(fixture.directory, "replica.sqlite"),
      source.projectId,
    );
    try {
      replica.setSynchronizationMode("manual");
      const schedule = replica.getSynchronizationSchedule();

      replica.bootstrapReplication(snapshot);

      expect(replica.getSynchronizationSchedule()).toEqual(schedule);
      expect(replica.getSynchronizationSchedule().mode).toBe("manual");
      expect(replica.captureReplication()).toEqual(snapshot);
      expect(replica.getReplicationOutbox()).toEqual([]);
      expect(replica.getReplicationState().sequence).toBe(0);
    } finally {
      replica.close();
    }
  });

  test("неизвестный режим из JavaScript отклоняется без изменения локальной политики", () => {
    const db = fixture.create();
    const schedule = db.getSynchronizationSchedule();
    const guard = db.getReplicationGuard();

    const failure = expectRelayError(
      () => Reflect.apply(db.setSynchronizationMode, db, ["unexpected"]),
      "INVALID_ARGUMENT",
    );

    expect(failure.exitCode).toBe(2);
    expect(db.getSynchronizationSchedule()).toEqual(schedule);
    expect(db.getReplicationGuard()).toEqual(guard);
  });

  test("неизвестный сохранённый mode отклоняется readonly-чтением без исправления повреждения", () => {
    const db = fixture.create();
    const generation = db.getGeneration();
    db.close();
    // Обходим CHECK только для моделирования повреждённого файла; штатный setter это значение отвергает.
    fixture.withRaw((raw) =>
      raw.exec(
        "PRAGMA ignore_check_constraints=ON; UPDATE synchronization_schedule SET mode='unexpected' WHERE singleton=1;",
      ),
    );
    const reader = ProjectDatabase.openReadonly(fixture.path);
    try {
      const failure = expectRelayError(
        () => reader.getSynchronizationSchedule(),
        "DATABASE_INVALID",
      );

      expect(failure.exitCode).toBe(1);
      expect(reader.getGeneration()).toBe(generation);
    } finally {
      reader.close();
    }
    fixture.withRaw((raw) => {
      expect(
        raw.query("SELECT mode FROM synchronization_schedule WHERE singleton=1").get(),
      ).toEqual({ mode: "unexpected" });
    });
  });
});
