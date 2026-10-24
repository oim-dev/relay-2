import { describe, expect, spyOn, test } from "bun:test";
import type { CommandCommitPlan, CommandStore, HistoryCheckpoint } from "@relay/contracts";
import { CommandExecutor } from "../../src/batch/batch";
import { HistoryService } from "../../src/history/history";
import { KnowledgeService } from "../../src/knowledge/knowledge";
import {
  completeHistorySession,
  forkHistorySession,
  currentHistoryRun,
  expectHistoryError,
  historyOwner,
  openHistoryIntent,
  snapshotHistoryStorage,
  withHistoryFixture,
} from "./history-fixture";

describe("Асинхронный план истории", () => {
  test("NamedCommand разрешает адрес принимаемого ребёнка, сохраняя ID в checkpoint", async () => {
    await withHistoryFixture(async (history, { db }) => {
      const parent = await history.start({ title: "Приёмка именованной командой" }, "автор");
      const intent = await openHistoryIntent(history, parent);
      const child = await forkHistorySession(history, history.get(parent.id), intent);
      const attached = await history.transition(
        child.id,
        "attach",
        {},
        { actor: "автор", ifRevision: child.revision },
      );
      await completeHistorySession(history, attached);
      const owner = history.get(parent.id);

      const result = await new CommandExecutor(db).execute(
        {
          op: "checkpoint.complete",
          ref: intent.key,
          ifRevision: owner.revision,
          input: {
            runId: owner.data.currentRunId,
            title: "Принять результат",
            body: "Готово",
            acceptedSessionIds: [child.key],
          },
        },
        { actor: "автор" },
      );

      const material = result.entities.find((entry) => entry.kind === "work-checkpoint");
      expect(material?.data.acceptedSessionIds).toEqual([child.id]);
      expect(history.intents(parent.id)).toEqual([]);
      expect(history.get(parent.id).revision).toBe(owner.revision + 1);
    });
  });

  test.each(["sessionId", "intentId"] as const)(
    "поздний материал нарушает predicate %s даже без смены CAS владельца",
    async (field) => {
      await withHistoryFixture(async (history, { db, connect }) => {
        const session = await history.start({ title: "Защита материалов" }, "автор");
        const foreign = await history.start({ title: "Чужая сессия" }, "автор");
        const intent = await openHistoryIntent(history, session);
        const owner = history.get(session.id);
        const second = connect();
        const ready = Promise.withResolvers<void>();
        const release = Promise.withResolvers<void>();
        const commit = db.commands.commit.bind(db.commands);
        const barrier = spyOn(db.commands, "commit").mockImplementationOnce(async (plan) => {
          ready.resolve();
          await release.promise;
          return commit(plan);
        });
        const pending = history.checkpoint(
          intent.id,
          "save",
          {
            runId: currentHistoryRun(owner).id,
            title: "Продолжение",
            body: "Подготовленный материал",
          },
          historyOwner(owner),
        );
        try {
          await ready.promise;
          const id = crypto.randomUUID();
          // Техническая вставка намеренно обходит CAS сессии, изолируя защиту состава/закрытия intent.
          second.insert({
            ...intent,
            id,
            key: `CP-${id}`,
            data: {
              ...intent.data,
              kind: field === "sessionId" ? "progress" : "result",
              intentId: intent.id,
              sessionId: field === "sessionId" ? session.id : foreign.id,
              runId:
                field === "sessionId"
                  ? currentHistoryRun(session).id
                  : currentHistoryRun(foreign).id,
              sequence: field === "sessionId" ? 2 : 1,
            },
          });
          const before = snapshotHistoryStorage(db);
          const outbox = db.getReplicationOutbox();
          release.resolve();

          const error = await expectHistoryError(() => pending, "COMMAND_CONTEXT_CHANGED");

          expect(error.details).toMatchObject({
            selector: {
              kind: "field",
              entityKind: "work-checkpoint",
              field,
              value: field === "sessionId" ? session.id : intent.id,
            },
          });
          expect(snapshotHistoryStorage(db)).toEqual(before);
          expect(db.getReplicationOutbox()).toEqual(outbox);
          expect(history.get(session.id)).toEqual(owner);
        } finally {
          release.resolve();
          await pending.catch(() => {});
          barrier.mockRestore();
        }
      });
    },
  );

  test("run ID занятый после подготовки не перевыделяется при конфликте commit", async () => {
    await withHistoryFixture(async (history, { db, connect }) => {
      const root = await history.start({ title: "Шаблон намеренного конкурента" }, "автор");
      const second = connect();
      const ready = Promise.withResolvers<CommandCommitPlan>();
      const release = Promise.withResolvers<void>();
      const commit = db.commands.commit.bind(db.commands);
      const barrier = spyOn(db.commands, "commit").mockImplementationOnce(async (plan) => {
        ready.resolve(plan);
        await release.promise;
        return commit(plan);
      });
      const pending = history.start({ title: "Подготовленный корень" }, "автор");
      try {
        const plan = await ready.promise;
        const effect = plan.transitions[0]?.effects[0];
        if (effect?.kind !== "entity" || typeof effect.after.data.currentRunId !== "string") {
          throw new Error("Ожидался рассчитанный корень с run ID");
        }
        const runId = effect.after.data.currentRunId;
        const id = crypto.randomUUID();
        // ID вложенного run не является entity address; конкурентная вставка проверяет array-item guard.
        second.insert({
          ...root,
          id,
          key: `S-${id}`,
          data: {
            ...root.data,
            currentRunId: runId,
            runs: [{ ...currentHistoryRun(root), id: runId, key: `RUN-${runId}` }],
          },
        });
        const before = snapshotHistoryStorage(db);
        release.resolve();

        const error = await expectHistoryError(() => pending, "COMMAND_CONTEXT_CHANGED");

        expect(error.details).toMatchObject({
          selector: {
            kind: "array-item",
            entityKind: "work-session",
            arrayField: "runs",
            itemField: "id",
            value: runId,
          },
        });
        expect(barrier).toHaveBeenCalledTimes(1);
        expect(snapshotHistoryStorage(db)).toEqual(before);
        expect(db.get(effect.after.id)).toBeUndefined();
      } finally {
        release.resolve();
        await pending.catch(() => {});
        barrier.mockRestore();
      }
    });
  });

  test("реально отложенный port исполняет batch со снимками названий и ревизий каждого шага", async () => {
    await withHistoryFixture(async (history, { db }) => {
      const session = await history.start({ title: "Исторические снимки" }, "автор");
      const document = await new KnowledgeService(db).create(
        "document",
        { name: "Первая редакция", body: "Основание" },
        "автор",
      );
      let commits = 0;
      const plans: CommandCommitPlan[] = [];
      const port: CommandStore = {
        projectId: db.projectId,
        /**
         * Делает отдельный async переход до настоящей загрузки SQLite.
         */
        async load(request) {
          await Promise.resolve();
          return db.commands.load(request);
        },
        /**
         * Сохраняет готовый план один раз после отдельного async перехода.
         */
        async commit(plan) {
          commits++;
          plans.push(plan);
          await Promise.resolve();
          return db.commands.commit(plan);
        },
      };
      const executor = new CommandExecutor(port);
      const result = await executor.executeCommands(
        [
          {
            op: "checkpoint.open",
            ref: session.id,
            ifRevision: session.revision,
            as: "intent",
            input: {
              runId: session.data.currentRunId,
              title: "Начало",
              body: "Исходный снимок",
              references: [document.key],
            },
          },
          {
            op: "document.update",
            ref: document.id,
            ifRevision: document.revision,
            as: "edited",
            input: { name: "Вторая редакция" },
          },
          {
            op: "document.rename",
            ref: document.id,
            ifRevision: { $revision: "edited" },
            input: { key: "DOC-NEW" },
          },
          {
            op: "checkpoint.save",
            ref: { $ref: "intent" },
            ifRevision: { $revision: "intent" },
            as: "progress",
            input: {
              runId: session.data.currentRunId,
              title: "Продолжение",
              body: "Новый снимок",
              references: [document.id],
            },
          },
          {
            op: "checkpoint.complete",
            ref: { $ref: "intent" },
            ifRevision: { $revision: "progress" },
            input: {
              runId: session.data.currentRunId,
              title: "Результат",
              body: "Готово",
            },
          },
        ],
        { actor: "автор", operationKey: "history-snapshots" },
      );

      expect(commits).toBe(1);
      const checkpoints = result.entities.filter(
        (entry): entry is HistoryCheckpoint => entry.kind === "work-checkpoint",
      );
      expect(checkpoints.map((entry) => entry.data.sessionRevision)).toEqual([2, 3, 4]);
      expect(checkpoints.map((entry) => entry.data.sequence)).toEqual([1, 2, 3]);
      expect(checkpoints[0]?.data.references).toEqual([
        { id: document.id, kind: "document", key: document.key, title: "Первая редакция" },
      ]);
      expect(checkpoints[1]?.data.references).toEqual([
        { id: document.id, kind: "document", key: "DOC-NEW", title: "Вторая редакция" },
      ]);
      expect(result.items.map((item) => item.owner.revision)).toEqual([2, 2, 3, 3, 4]);
      expect(history.get(session.id).revision).toBe(4);
      expect(plans[0]?.transitions).toHaveLength(5);
      const receipt = new CommandExecutor(db).getResult("history-snapshots");
      expect(receipt.entities).toEqual(result.entities);
    });
  });

  test("два takeover из одного снимка не объединяют владение и не повторяют проигравший план", async () => {
    await withHistoryFixture(async (history, { db, connect }) => {
      const session = await history.start({ title: "Конкурирующее владение" }, "автор");
      const second = new HistoryService(connect());
      const ready = Promise.withResolvers<CommandCommitPlan>();
      const release = Promise.withResolvers<void>();
      const commit = db.commands.commit.bind(db.commands);
      const barrier = spyOn(db.commands, "commit").mockImplementationOnce(async (plan) => {
        ready.resolve(plan);
        await release.promise;
        return commit(plan);
      });
      const pending = history.transition(
        session.id,
        "takeover",
        { reason: "Первая попытка" },
        { actor: "первый", ifRevision: 1 },
      );
      try {
        const plan = await ready.promise;
        const winner = await second.transition(
          session.id,
          "takeover",
          { reason: "Вторая попытка" },
          { actor: "второй", ifRevision: 1 },
        );
        const before = snapshotHistoryStorage(db);
        const outbox = db.getReplicationOutbox();
        release.resolve();

        await expectHistoryError(() => pending, "COMMAND_CONTEXT_CHANGED");

        expect(barrier).toHaveBeenCalledTimes(1);
        expect(snapshotHistoryStorage(db)).toEqual(before);
        expect(db.getReplicationOutbox()).toEqual(outbox);
        expect(history.get(session.id)).toEqual(winner);
        expect(winner.data.runs.map((run) => run.actor)).toEqual(["автор", "второй"]);
        const losing = plan.transitions[0]?.effects[0];
        expect(losing?.kind).toBe("entity");
        if (losing?.kind === "entity") {
          expect(losing.before?.revision).toBe(1);
          expect(losing.after.revision).toBe(2);
          expect(losing.after.data.currentRunId).not.toBe(winner.data.currentRunId);
        }
      } finally {
        release.resolve();
        await pending.catch(() => {});
        barrier.mockRestore();
      }
    });
  });

  test("новый ребёнок после подготовки закрытия нарушает отрицательный predicate без частичной записи", async () => {
    await withHistoryFixture(async (history, { db, connect }) => {
      const session = await history.start({ title: "Защита пустого состава детей" }, "автор");
      const intent = await openHistoryIntent(history, session);
      const owner = history.get(session.id);
      const second = connect();
      const ready = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const commit = db.commands.commit.bind(db.commands);
      const barrier = spyOn(db.commands, "commit").mockImplementationOnce(async (plan) => {
        ready.resolve();
        await release.promise;
        return commit(plan);
      });
      const pending = history.checkpoint(
        intent.id,
        "complete",
        { runId: currentHistoryRun(owner).id, title: "Закрытие", body: "Детей нет" },
        historyOwner(owner),
      );
      try {
        await ready.promise;
        const id = crypto.randomUUID();
        // Намеренная техническая вставка не повышает CAS родителя: проверяется именно phantom guard.
        second.insert({
          ...session,
          id,
          key: `S-${id}`,
          data: {
            ...session.data,
            title: "Поздний ребёнок",
            status: "pending",
            currentRunId: null,
            runs: [],
            parentSessionId: session.id,
            originCheckpointId: intent.id,
            createdByRunId: session.data.currentRunId,
          },
        });
        const before = snapshotHistoryStorage(db);
        const outbox = db.getReplicationOutbox();
        release.resolve();

        const error = await expectHistoryError(() => pending, "COMMAND_CONTEXT_CHANGED");

        expect(error.details).toMatchObject({
          selector: {
            kind: "field",
            entityKind: "work-session",
            field: "parentSessionId",
            value: session.id,
          },
        });
        expect(snapshotHistoryStorage(db)).toEqual(before);
        expect(db.getReplicationOutbox()).toEqual(outbox);
        expect(history.get(session.id)).toEqual(owner);
        expect(history.history(session.id)).toEqual([intent]);
      } finally {
        release.resolve();
        await pending.catch(() => {});
        barrier.mockRestore();
      }
    });
  });
});
