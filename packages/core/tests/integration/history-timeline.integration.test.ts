import { describe, expect, test } from "bun:test";
import { RelayError } from "@relay/contracts";
import { HistoryService } from "../../src/history/history";
import { readHistoryTimeline } from "../../src/history/history-timeline";
import { withGraphViewFixture } from "./graph-view-fixture";

describe("Компактная хронология Core", () => {
  test("одинаковые native ID участий разных сессий не смешивают создателя ребёнка и его агента", async () => {
    await withGraphViewFixture(async (db) => {
      const history = new HistoryService(db);
      const root = await history.start({ title: "Родитель" }, "Родительский агент");
      const run = root.data.runs[0];
      if (!run) {
        throw new Error("Нет участия родителя.");
      }
      const intent = await history.checkpoint(
        root.id,
        "open",
        { runId: run.id, title: "Поручение", body: "Проверить часть работы" },
        { actor: run.actor, ifRevision: root.revision },
      );
      const child = await history.transition(
        intent.id,
        "fork",
        { runId: run.id, title: "Дочерняя работа" },
        { actor: run.actor, ifRevision: history.get(root.id).revision },
      );
      // Native ID primary part scoped по ownerId: две валидные сессии могут иметь одинаковый ID run.
      db.update(
        {
          ...child,
          revision: child.revision + 1,
          updatedBy: "Дочерний агент",
          data: {
            ...child.data,
            status: "open",
            currentRunId: run.id,
            runs: [{ ...run, actor: "Дочерний агент", startedAt: child.createdAt }],
          },
        },
        child.revision,
      );
      expect(history.get(child.id).data.runs[0]?.actor).toBe("Дочерний агент");

      const page = readHistoryTimeline(db);

      expect(page.items.find((point) => point.id === `${child.id}:created`)).toMatchObject({
        runId: run.id,
        runSessionId: root.id,
      });
      expect(
        page.items.find((point) => point.id === `${child.id}~${run.id}:started`),
      ).toMatchObject({ runId: run.id, runSessionId: child.id });
      expect(
        page.runs
          .filter((entry) => entry.id === run.id)
          .map((entry) => [entry.sessionId, entry.actor])
          .sort(),
      ).toEqual(
        [
          [root.id, "Родительский агент"],
          [child.id, "Дочерний агент"],
        ].sort(),
      );
    });
  });
  test("повреждённое авторство материала отклоняется вместо пропуска точки", async () => {
    await withGraphViewFixture(async (db) => {
      const history = new HistoryService(db);
      const session = await history.start({ title: "Работа" }, "Автор");
      const run = session.data.runs[0];
      if (!run) {
        throw new Error("Нет участия.");
      }
      const intent = await history.checkpoint(
        session.id,
        "open",
        { runId: run.id, title: "Намерение", body: "Текст" },
        { actor: "Автор", ifRevision: session.revision },
      );
      const id = crypto.randomUUID();
      // Намеренно повреждённая ссылка; прочие поля материала сохранены валидными.
      db.insert({
        ...intent,
        id,
        key: `CP-${id}`,
        data: { ...intent.data, runId: crypto.randomUUID() },
      });
      const generation = db.getGeneration();

      let failure: unknown;
      try {
        readHistoryTimeline(db);
      } catch (error) {
        failure = error;
      }

      expect(failure).toMatchObject({
        code: "CORRUPT_DATA",
        details: { id, field: "session/run/actor" },
      });
      expect(db.getGeneration()).toBe(generation);
    });
  });
  test("проект больше 1000 записей читается ограниченными страницами без полных тел", async () => {
    await withGraphViewFixture(async (db) => {
      const history = new HistoryService(db);
      const template = await history.start(
        { title: "Работа", description: "Тяжёлый текст: " + "x".repeat(32000) },
        "Автор",
      );
      const templateRun = template.data.runs[0];
      if (!templateRun) {
        throw new Error("У стартовой сессии обязателен run.");
      }
      // Валидные независимые стартовые сессии; масштаб проверяет прежний порог, не скорость writes.
      db.transaction(() => {
        for (let i = 0; i < 1000; i++) {
          const id = crypto.randomUUID();
          const runId = crypto.randomUUID();
          db.insert({
            ...template,
            id,
            key: `S-${id}`,
            data: {
              ...template.data,
              description: null,
              currentRunId: runId,
              runs: [{ ...templateRun, id: runId, key: `RUN-${runId}` }],
            },
          });
        }
      });

      const first = readHistoryTimeline(db, { limit: 3 });
      const next = readHistoryTimeline(db, {
        offset: first.nextOffset ?? 0,
        limit: 3,
        generation: first.generation,
      });

      expect(first.total).toBe(1001);
      expect(first.items).toHaveLength(3);
      expect(first.openEnds).toHaveLength(3);
      expect(first.totalOpenEnds).toBe(1001);
      expect(next.items).toHaveLength(3);
      expect(
        next.items.every((point) => !first.items.some((previous) => previous.id === point.id)),
      ).toBe(true);
      expect(JSON.stringify(first)).not.toContain("Тяжёлый текст:");
      expect(
        db.listGraphSources("history").find((record) => record.id === template.id)?.data,
      ).not.toHaveProperty("description");
      expect(first.branches.length).toBeLessThanOrEqual(6);
    });
  });

  test("старый незакрытый конец остаётся видимым за пределами окна новых завершений", async () => {
    await withGraphViewFixture(async (db) => {
      const history = new HistoryService(db);
      const old = await history.start({ title: "Ожидающая работа" }, "Автор");
      const oldRun = old.data.runs[0];
      if (!oldRun) {
        throw new Error("Нет участия.");
      }
      const archivedId = crypto.randomUUID();
      const archivedRunId = crypto.randomUUID();
      db.insert({
        ...old,
        id: archivedId,
        key: `S-${archivedId}`,
        createdAt: "2000-01-01T00:00:00.000Z",
        updatedAt: "2000-01-01T00:00:00.000Z",
        data: {
          ...old.data,
          currentRunId: archivedRunId,
          runs: [
            {
              ...oldRun,
              id: archivedRunId,
              key: `RUN-${archivedRunId}`,
              startedAt: "2000-01-01T00:00:00.000Z",
            },
          ],
        },
      });
      await history.transition(
        old.id,
        "complete",
        { runId: oldRun.id, result: "Готово" },
        { actor: "Автор", ifRevision: old.revision },
      );

      const page = readHistoryTimeline(db, { limit: 1 });

      expect(page.items[0]?.id).toBe(`${old.id}:closed`);
      expect(page.openEnds.map((point) => [point.id, point.at])).toEqual([
        [`${archivedId}:created`, "2000-01-01T00:00:00.000Z"],
      ]);
      expect(page.boundaryNodes.some((point) => point.id === `${old.id}:created`)).toBe(true);
      expect(page.edges).toContainEqual({
        kind: "sequence",
        from: `${old.id}:created`,
        to: `${old.id}:closed`,
      });
    });
  });

  test("автор ребёнка, состояние intent вне окна и ID/ключ/типизированный алиас согласованы", async () => {
    await withGraphViewFixture(async (db) => {
      const history = new HistoryService(db);
      const root = await history.start({ title: "Корень" }, "Автор");
      const run = root.data.runs[0];
      if (!run) {
        throw new Error("Нет участия.");
      }
      const intent = await history.checkpoint(
        root.id,
        "open",
        { runId: run.id, title: "Намерение", body: "BODY-SENTINEL" },
        { actor: "Автор", ifRevision: root.revision },
      );
      const child = await history.transition(
        intent.id,
        "fork",
        { runId: run.id, title: "Дочерняя работа" },
        { actor: "Автор", ifRevision: history.get(root.id).revision },
      );
      await history.transition(
        child.id,
        "cancel",
        { result: "Не требуется" },
        { actor: "Автор", ifRevision: child.revision },
      );
      await history.checkpoint(
        intent.id,
        "complete",
        { runId: run.id, title: "Результат", body: "RESULT-SENTINEL" },
        { actor: "Автор", ifRevision: history.get(root.id).revision },
      );
      db.rename(root.id, "history-alias", history.get(root.id).revision, "Автор");

      const page = readHistoryTimeline(db, { limit: 100 });
      const byAlias = readHistoryTimeline(db, { session: `work-session:${root.key}` });
      const byId = readHistoryTimeline(db, { session: root.id });

      expect(page.items.find((point) => point.id === `${child.id}:created`)?.runId).toBe(run.id);
      expect(page.items.find((point) => point.id === `${intent.id}:checkpoint`)?.intentState).toBe(
        "completed",
      );
      expect(page.edges).toContainEqual({
        kind: "fork",
        fromSessionId: root.id,
        to: `${child.id}:created`,
      });
      expect(byAlias.items.map((point) => point.id)).toEqual(byId.items.map((point) => point.id));
      expect(JSON.stringify(page)).not.toContain("BODY-SENTINEL");
      expect(JSON.stringify(page)).not.toContain("RESULT-SENTINEL");
    });
  });

  test("смена поколения отклоняет продолжение до чтения metadata", async () => {
    await withGraphViewFixture(async (db) => {
      const history = new HistoryService(db);
      await history.start({ title: "Первая" }, "Автор");
      const page = readHistoryTimeline(db, { limit: 1 });
      await history.start({ title: "Вторая" }, "Автор");
      const original = db.listGraphSources.bind(db);
      let read = false;
      db.listGraphSources = (view) => {
        read = true;
        return original(view);
      };

      expect(() =>
        readHistoryTimeline(db, { offset: 1, limit: 1, generation: page.generation }),
      ).toThrow(RelayError);
      try {
        readHistoryTimeline(db, { offset: 1, generation: page.generation });
      } catch (error) {
        expect(error).toMatchObject({ code: "PAGE_CHANGED" });
      }
      expect(read).toBe(false);
    });
  });
});
