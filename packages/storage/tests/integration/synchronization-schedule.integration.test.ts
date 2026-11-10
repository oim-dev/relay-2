import { afterEach, beforeEach, describe, expect, spyOn, test, type Mock } from "bun:test";
import { join } from "node:path";
import { ProjectDatabase } from "../../src/database/project-database";
import { planReplicationImport } from "../../src/replication/replication-import-plan";
import {
  ProjectDatabaseFixture,
  createDocument,
  expectRelayError,
} from "./helpers/project-database-fixture";

const writeFailures = [
  {
    name: "отказ записи расписания",
    trigger: "BEFORE UPDATE",
    body: "SELECT RAISE(ABORT, 'fixture: schedule write rejected');",
    reason: "fixture: schedule write rejected",
  },
  {
    name: "отказ COMMIT после записи расписания",
    trigger: "AFTER UPDATE",
    body: "UPDATE project_state SET project_id='missing-project' WHERE singleton=1;",
    reason: "FOREIGN KEY constraint failed",
  },
] as const;
const importCases = [
  { name: "полный снимок", sparse: false },
  { name: "подготовленный sparse plan", sparse: true },
] as const;
const invalidAttempts = [
  { name: "отрицательное время завершения", at: -1, nextAttemptAt: 2_000 },
  { name: "дробное время следующей попытки", at: 1_000, nextAttemptAt: 2_000.5 },
  { name: "нечисловое время завершения", at: Number.NaN, nextAttemptAt: 2_000 },
  { name: "небезопасное целое следующей попытки", at: 1_000, nextAttemptAt: 2 ** 53 },
] as const;
let fixture: ProjectDatabaseFixture;
let clock: Mock<typeof Date.now>;

beforeEach(() => {
  fixture = new ProjectDatabaseFixture("schedule", "project-local-sync/storage-review");
  // Подменяются только часы отметки мутации, не SQL, транзакции или durable outbox.
  clock = spyOn(Date, "now").mockReturnValue(1_000);
});

afterEach(() => {
  clock.mockRestore();
  fixture.close();
});

describe("Общее локальное расписание синхронизации", () => {
  test("создание и новые changeset сохраняют начало серии и последнее время, включая receipt-only и reopen", () => {
    const db = fixture.create();
    const document = createDocument();
    const receipt = { operationKey: "receipt-only", requestJson: "{}", resultJson: "{}" };
    expect(db.getSynchronizationSchedule()).toEqual({
      mode: "auto",
      dirtySince: 1_000,
      lastMutationAt: 1_000,
      nextAttemptAt: 0,
      lastAttemptAt: null,
      failures: 0,
    });
    clock.mockReturnValue(2_000);
    db.insert(document);
    const generation = db.getGeneration();
    expect(db.getSynchronizationSchedule().lastMutationAt).toBe(2_000);
    clock.mockReturnValue(3_000);

    db.insertBatchReceipt(receipt);
    db.close();
    const reopened = fixture.open();

    expect(reopened.getSynchronizationSchedule()).toEqual({
      mode: "auto",
      dirtySince: 1_000,
      lastMutationAt: 3_000,
      nextAttemptAt: 0,
      lastAttemptAt: null,
      failures: 0,
    });
    expect(reopened.getGeneration()).toBe(generation);
    expect(reopened.get(document.id)).toEqual(document);
    expect(reopened.getReplicationOutbox()).toHaveLength(3);
    expect(reopened.getReplicationOutbox().at(-1)).toMatchObject({
      entities: [],
      comments: [],
      receipts: [receipt],
    });
  });

  test("чтения, пустая транзакция и rename no-op не отмечают новую мутацию", () => {
    const db = fixture.create();
    const schedule = db.getSynchronizationSchedule();
    const guard = db.getReplicationGuard();
    const queue = db.getReplicationOutbox();
    clock.mockReturnValue(2_000);

    db.snapshot(() => db.get("PROJECT"));
    db.transaction(() => {});
    db.rename(db.projectId, "PROJECT", 1, "tester");

    expect(db.getSynchronizationSchedule()).toEqual(schedule);
    expect(db.getReplicationGuard()).toEqual(guard);
    expect(db.getReplicationOutbox()).toEqual(queue);
  });

  test("перехваченный rollback savepoint не сдвигает расписание внешней транзакции", () => {
    const db = fixture.create();
    const document = createDocument();
    const schedule = db.getSynchronizationSchedule();
    const queue = db.getReplicationOutbox();
    const failure = new Error("Намеренный rollback вложенной записи");
    clock.mockReturnValue(2_000);

    db.transaction(() => {
      expect(() =>
        db.transaction(() => {
          db.insert(document);
          throw failure;
        }),
      ).toThrow(failure);
    });

    expect(db.get(document.id)).toBeUndefined();
    expect(db.getSynchronizationSchedule()).toEqual(schedule);
    expect(db.getReplicationOutbox()).toEqual(queue);
  });

  test.each(writeFailures)(
    "$name откатывает данные, outbox и отметки после reopen",
    ({ trigger, body, reason }) => {
      const db = fixture.create();
      const schedule = db.getSynchronizationSchedule();
      const queue = db.getReplicationOutbox();
      const guard = db.getReplicationGuard();
      const document = createDocument();
      // AFTER UPDATE портит отложенный FK: отметка уже записана, но COMMIT обязан откатить её.
      fixture.withRaw((raw) =>
        raw.exec(`CREATE TRIGGER reject_schedule ${trigger}
      ON synchronization_schedule BEGIN ${body} END`),
      );
      clock.mockReturnValue(2_000);

      const failure = expectRelayError(() => db.insert(document), "CONFLICT");
      db.close();
      const reopened = fixture.open();

      expect(failure.details).toMatchObject({ reason });
      expect(reopened.get(document.id)).toBeUndefined();
      expect(reopened.get(document.key)).toBeUndefined();
      expect(reopened.getSynchronizationSchedule()).toEqual(schedule);
      expect(reopened.getReplicationOutbox()).toEqual(queue);
      expect(reopened.getReplicationGuard()).toEqual(guard);
    },
  );

  test("отказы сохраняют backoff, успех очищает завершённую серию, новая запись начинает следующую", () => {
    const db = fixture.create();
    db.setSynchronizationMode("manual");
    const queue = db.getReplicationOutbox();
    const guard = db.getReplicationGuard();

    db.completeSynchronizationAttempt({ at: 2_000, nextAttemptAt: 4_000, failed: true });
    db.completeSynchronizationAttempt({ at: 5_000, nextAttemptAt: 8_000, failed: true });
    db.close();
    const reopened = fixture.open();

    expect(reopened.getSynchronizationSchedule()).toEqual({
      mode: "manual",
      dirtySince: 1_000,
      lastMutationAt: 1_000,
      nextAttemptAt: 8_000,
      lastAttemptAt: 5_000,
      failures: 2,
    });
    expect(reopened.getReplicationGuard()).toEqual(guard);
    expect(reopened.getReplicationOutbox()).toEqual(queue);
    reopened.updateReplicationState({
      conflicts: [],
      acknowledged: queue.map((entry) => entry.id),
    });
    const acknowledgedGuard = reopened.getReplicationGuard();

    reopened.completeSynchronizationAttempt({ at: 9_000, nextAttemptAt: 12_000, failed: false });

    expect(reopened.getSynchronizationSchedule()).toEqual({
      mode: "manual",
      dirtySince: null,
      lastMutationAt: 1_000,
      nextAttemptAt: 12_000,
      lastAttemptAt: 9_000,
      failures: 0,
    });
    expect(reopened.getReplicationGuard()).toEqual(acknowledgedGuard);
    expect(reopened.getReplicationOutbox()).toEqual([]);
    clock.mockReturnValue(10_000);

    reopened.insert(createDocument());

    expect(reopened.getSynchronizationSchedule()).toEqual({
      mode: "manual",
      dirtySince: 10_000,
      lastMutationAt: 10_000,
      nextAttemptAt: 12_000,
      lastAttemptAt: 9_000,
      failures: 0,
    });
  });

  test("поздняя receipt-only запись другого соединения сохраняет dirty при завершении попытки", () => {
    const transport = fixture.create();
    const writer = fixture.open();
    const publishedIds = transport.getReplicationOutbox().map((entry) => entry.id);
    const generation = transport.getGeneration();
    const lateReceipt = { operationKey: "late", requestJson: "{}", resultJson: "{}" };
    transport.updateReplicationState({ conflicts: [], acknowledged: publishedIds });
    expect(transport.getReplicationOutbox()).toEqual([]);
    clock.mockReturnValue(3_000);
    // Сеть уже закончилась и ack применён, но mutex транспорта не блокирует предметного writer.
    writer.insertBatchReceipt(lateReceipt);

    transport.completeSynchronizationAttempt({ at: 4_000, nextAttemptAt: 5_000, failed: false });

    expect(writer.getSynchronizationSchedule()).toEqual({
      mode: "auto",
      dirtySince: 1_000,
      lastMutationAt: 3_000,
      nextAttemptAt: 5_000,
      lastAttemptAt: 4_000,
      failures: 0,
    });
    expect(transport.getGeneration()).toBe(generation);
    expect(transport.getReplicationOutbox()).toHaveLength(1);
    expect(transport.getReplicationOutbox()[0]?.receipts).toEqual([lateReceipt]);
  });

  test("createReplica и bootstrap не наследуют dirty технической инициализации", () => {
    const source = fixture.create();
    source.setSynchronizationMode("manual");
    const snapshot = source.captureReplication();
    const replica = ProjectDatabase.createReplica(
      join(fixture.directory, "replica.sqlite"),
      source.projectId,
    );
    const cleanSchedule = {
      mode: "auto",
      dirtySince: null,
      lastMutationAt: null,
      nextAttemptAt: 0,
      lastAttemptAt: null,
      failures: 0,
    } as const;
    try {
      expect(replica.getSynchronizationSchedule()).toEqual(cleanSchedule);
      expect(replica.getReplicationOutbox()).toEqual([]);
      clock.mockReturnValue(2_000);

      replica.bootstrapReplication(snapshot);

      expect(replica.captureReplication()).toEqual(snapshot);
      expect(replica.getSynchronizationSchedule()).toEqual(cleanSchedule);
      expect(replica.getReplicationOutbox()).toEqual([]);
      expect(replica.getReplicationState().sequence).toBe(0);
      clock.mockReturnValue(3_000);

      replica.insertBatchReceipt({
        operationKey: "first-local",
        requestJson: "{}",
        resultJson: "{}",
      });

      expect(replica.getSynchronizationSchedule()).toEqual({
        ...cleanSchedule,
        dirtySince: 3_000,
        lastMutationAt: 3_000,
      });
      expect(replica.getReplicationOutbox()).toHaveLength(1);
      expect(replica.getReplicationState().sequence).toBe(1);
    } finally {
      replica.close();
    }
  });

  test.each(importCases)(
    "$name импортирует данные без echo и сдвига расписания локального pending",
    ({ sparse }) => {
      const source = fixture.create();
      const replica = ProjectDatabase.createReplica(
        join(fixture.directory, "replica.sqlite"),
        source.projectId,
      );
      try {
        replica.bootstrapReplication(source.captureReplication());
        replica.setSynchronizationMode("manual");
        const document = createDocument();
        const remoteReceipt = { operationKey: "remote", requestJson: "{}", resultJson: "{}" };
        source.transaction(() => {
          source.insert(document);
          source.insertBatchReceipt(remoteReceipt);
        });
        const localReceipt = { ...remoteReceipt, operationKey: "local" };
        clock.mockReturnValue(2_000);
        replica.insertBatchReceipt(localReceipt);
        const snapshot = source.captureReplication();
        const merged = { ...snapshot, receipts: [localReceipt, ...snapshot.receipts] };
        const plan = sparse
          ? planReplicationImport(replica.captureReplication(), merged)
          : undefined;
        const schedule = replica.getSynchronizationSchedule();
        const queue = replica.getReplicationOutbox();
        const generation = replica.getGeneration();
        clock.mockReturnValue(3_000);

        replica.importReplication(merged, plan);

        expect(replica.get(document.id)).toEqual(document);
        expect(replica.getBatchReceipt(remoteReceipt.operationKey)).toEqual(remoteReceipt);
        expect(replica.getBatchReceipt(localReceipt.operationKey)).toEqual(localReceipt);
        expect(replica.getGeneration()).toBeGreaterThan(generation);
        expect(replica.getSynchronizationSchedule()).toEqual(schedule);
        expect(replica.getSynchronizationSchedule().mode).toBe("manual");
        expect(replica.getReplicationOutbox()).toEqual(queue);
      } finally {
        replica.close();
      }
    },
  );

  test.each(invalidAttempts)(
    "$name отклоняется без частичного обновления расписания",
    ({ at, nextAttemptAt }) => {
      const db = fixture.create();
      const schedule = db.getSynchronizationSchedule();
      const guard = db.getReplicationGuard();
      const queue = db.getReplicationOutbox();

      expectRelayError(
        () => db.completeSynchronizationAttempt({ at, nextAttemptAt, failed: true }),
        "INVALID_ARGUMENT",
      );

      expect(db.getSynchronizationSchedule()).toEqual(schedule);
      expect(db.getReplicationGuard()).toEqual(guard);
      expect(db.getReplicationOutbox()).toEqual(queue);
    },
  );
});
