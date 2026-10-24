import { describe, expect, test } from "bun:test";
import type { CommandWriteOptions } from "@relay/contracts";
import { CommandExecutor } from "../../src/batch/batch";
import { HistoryService } from "../../src/history/history";
import { expectHistoryError, snapshotHistoryStorage, withHistoryFixture } from "./history-fixture";

const invalidNumericCases = [
  { name: "ноль", ifRevision: 0 },
  { name: "дробная ревизия", ifRevision: 1.5 },
  { name: "строка", ifRevision: "1" },
  { name: "null", ifRevision: null },
] as const;

describe("Переносимое условие публичного HistoryService", () => {
  test("version-only checkpoint и fork используют token сессии, устаревший token не обновляется", async () => {
    await withHistoryFixture(async (history, { db }) => {
      const session = await history.start({ title: "Версия владельца" }, "автор");
      const executor = new CommandExecutor(db);
      const initial = await executor.readVersioned(session.id);

      const intent = await history.checkpoint(
        session.id,
        "open",
        {
          title: "Намерение",
          body: "Сохранить основание",
          runId: session.data.currentRunId,
        },
        { actor: "автор", expectedVersion: initial.versions.aggregateVersion },
      );
      const observed = await executor.readVersioned(session.id);
      const intentVersion = await executor.readVersioned(intent.id);
      const beforeWrongOwner = snapshotHistoryStorage(db);
      await expectHistoryError(
        () =>
          history.transition(
            intent.id,
            "fork",
            {
              title: "Token не того владельца",
              runId: session.data.currentRunId,
            },
            { actor: "автор", expectedVersion: intentVersion.versions.aggregateVersion },
          ),
        "VERSION_CONFLICT",
      );
      expect(snapshotHistoryStorage(db)).toEqual(beforeWrongOwner);

      const child = await history.transition(
        intent.id,
        "fork",
        {
          title: "Дочерняя проверка",
          runId: session.data.currentRunId,
        },
        { actor: "автор", expectedVersion: observed.versions.aggregateVersion },
      );
      const before = snapshotHistoryStorage(db);
      await expectHistoryError(
        () =>
          history.checkpoint(
            intent.id,
            "save",
            {
              title: "Устаревший контекст",
              body: "Не сохранять",
              runId: session.data.currentRunId,
            },
            { actor: "автор", expectedVersion: observed.versions.aggregateVersion },
          ),
        "VERSION_CONFLICT",
      );

      expect(intent.data.sessionRevision).toBe(2);
      expect(child.data).toMatchObject({
        status: "pending",
        parentSessionId: session.id,
        originCheckpointId: intent.id,
      });
      expect(history.get(session.id).revision).toBe(3);
      expect(snapshotHistoryStorage(db)).toEqual(before);
    });
  });

  test("constructor default допускает отсутствие numeric CAS, явный token метода имеет приоритет", async () => {
    await withHistoryFixture(async (history, { db }) => {
      const session = await history.start({ title: "Условие конструктора" }, "автор");
      const executor = new CommandExecutor(db);
      const initial = await executor.readVersioned(session.id);
      const facade = new HistoryService(db, { expectedVersion: initial.versions.aggregateVersion });

      await expectHistoryError(
        () =>
          facade.transition(
            session.id,
            "pause",
            { runId: session.data.currentRunId, reason: "Неверное число" },
            { actor: "автор", ifRevision: 0 },
          ),
        "INVALID_INPUT",
      );
      await expectHistoryError(
        () =>
          facade.transition(
            session.id,
            "pause",
            { runId: session.data.currentRunId, reason: "Неверный явный token" },
            { actor: "автор", expectedVersion: "" },
          ),
        "INVALID_ARGUMENT",
      );
      expect(history.get(session.id)).toEqual(session);

      const paused = await facade.transition(
        session.id,
        "pause",
        { runId: session.data.currentRunId, reason: "Пауза" },
        { actor: "автор" },
      );
      const current = await executor.readVersioned(session.id);
      const resumed = await facade.transition(
        session.id,
        "resume",
        {},
        { actor: "автор", expectedVersion: current.versions.aggregateVersion },
      );
      const before = snapshotHistoryStorage(db);
      await expectHistoryError(
        () =>
          facade.transition(
            session.id,
            "pause",
            { runId: resumed.data.currentRunId, reason: "Устаревший default" },
            { actor: "автор" },
          ),
        "VERSION_CONFLICT",
      );

      expect(paused.data.status).toBe("paused");
      expect(resumed.data.status).toBe("open");
      expect(resumed.revision).toBe(3);
      expect(resumed.data.runs.map((run) => run.state)).toEqual(["paused", "active"]);
      expect(snapshotHistoryStorage(db)).toEqual(before);
    });
  });

  test.each(invalidNumericCases)(
    "валидный token не скрывает недопустимый ifRevision: $name",
    async ({ ifRevision }) => {
      await withHistoryFixture(async (history, { db }) => {
        const session = await history.start({ title: "Два исходных условия" }, "автор");
        const current = await new CommandExecutor(db).readVersioned(session.id);
        const invalidOptions = {
          actor: "автор",
          expectedVersion: current.versions.aggregateVersion,
          ifRevision,
        };
        const before = snapshotHistoryStorage(db);

        // Намеренно нарушаем TypeScript-контракт для проверки внешней границы без ослабления parser.
        await expectHistoryError(
          () =>
            history.transition(
              session.id,
              "pause",
              {
                runId: session.data.currentRunId,
                reason: "Не сохранять",
              },
              invalidOptions as CommandWriteOptions,
            ),
          "INVALID_INPUT",
        );

        expect(snapshotHistoryStorage(db)).toEqual(before);
      });
    },
  );

  test("устаревший numeric CAS проверяется вместе со свежим token, неизвестные поля сохраняют отказ", async () => {
    await withHistoryFixture(async (history, { db }) => {
      const session = await history.start({ title: "Оба guard обязательны" }, "автор");
      await history.transition(
        session.id,
        "takeover",
        { reason: "Новый run" },
        { actor: "автор", ifRevision: 1 },
      );
      const current = await new CommandExecutor(db).readVersioned(session.id);
      const owner = history.get(session.id);
      const before = snapshotHistoryStorage(db);

      await expectHistoryError(
        () =>
          history.checkpoint(
            session.id,
            "open",
            {
              runId: owner.data.currentRunId,
              title: "Не сохранять",
              body: "Устаревшее число",
            },
            { actor: "автор", ifRevision: 1, expectedVersion: current.versions.aggregateVersion },
          ),
        "REVISION_CONFLICT",
      );
      await expectHistoryError(
        () =>
          history.transition(
            session.id,
            "pause",
            {
              runId: owner.data.currentRunId,
              reason: "Не сохранять",
            },
            {
              actor: "автор",
              expectedVersion: current.versions.aggregateVersion,
              unknown: true,
            } as CommandWriteOptions,
          ),
        "INVALID_INPUT",
      );
      await expectHistoryError(
        () =>
          history.transition(
            session.id,
            "pause",
            {
              runId: owner.data.currentRunId,
              reason: "Не сохранять",
            },
            { actor: "автор" },
          ),
        "INVALID_INPUT",
      );

      expect(snapshotHistoryStorage(db)).toEqual(before);
    });
  });
});
