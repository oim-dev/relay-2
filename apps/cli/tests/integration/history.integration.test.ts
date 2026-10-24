import { describe, expect, test } from "bun:test";
import { HistoryService, type ProjectDatabase } from "@relay/core";
import { withCliFixture } from "./helpers/cli-fixture";
import { arrayValue, entityValue, objectValue, stringValue } from "./helpers/responses";
import type { OpenIntentFixture } from "./helpers/history-fixture.types";

const checkpointInputs = [
  { name: "флаг run", source: "flags" },
  { name: "JSON runId", source: "json" },
] as const;

/**
 * Создаёт сессию и открытое намерение через Core, возвращая актуальную ревизию владельца.
 * Переданное соединение остаётся во владении вызывающей fixture.
 */
async function createSessionWithIntent(db: ProjectDatabase): Promise<OpenIntentFixture> {
  const history = new HistoryService(db);
  const started = await history.start({ title: "Поручение" }, "agent");
  const runId = stringValue(started.data.currentRunId);
  const intent = await history.checkpoint(
    started.id,
    "open",
    {
      runId,
      title: "Проверить",
      body: "План проверки",
    },
    { actor: "agent", ifRevision: started.revision },
  );
  return { session: history.get(started.id), runId, intent };
}

describe("Рабочая история через CLI", () => {
  test("JSON запуска сессии сохраняет каноническое поле operator", async () => {
    await withCliFixture(async (cli) => {
      cli.createProject();
      const operator = { name: "Человек", email: null, source: "explicit" };

      const session = await cli.entity([
        "session",
        "start",
        "--input",
        JSON.stringify({ title: "Поручение", operator }),
      ]);

      const runs = arrayValue(session.data.runs).map(objectValue);
      expect(runs).toHaveLength(1);
      expect(runs[0]).toMatchObject({ id: session.data.currentRunId, operator });
      expect(await cli.entity(["session", "get", session.key])).toEqual(session);
    });
  });

  test("флаг user-name преобразуется в operator текущего участия", async () => {
    await withCliFixture(async (cli) => {
      cli.createProject();

      const session = await cli.entity([
        "session",
        "start",
        "--title",
        "Поручение",
        "--user-name",
        "Человек",
      ]);

      const runs = arrayValue(session.data.runs).map(objectValue);
      expect(runs).toHaveLength(1);
      expect(runs[0]).toMatchObject({
        id: session.data.currentRunId,
        operator: { name: "Человек", email: null, source: "explicit" },
      });
    });
  });

  test.each(checkpointInputs)(
    "открытие намерения через $name сохраняет текущий run",
    async ({ source }) => {
      await withCliFixture(async (cli) => {
        const project = cli.createProject();
        const session = await cli.withDatabase(
          project,
          async (db) => await new HistoryService(db).start({ title: "Поручение" }, "agent"),
        );
        const runId = stringValue(session.data.currentRunId);
        const material = { title: "Материал", body: "План проверки\n  с отступом\n" };
        const input =
          source === "json"
            ? ["--input", JSON.stringify({ runId, ...material })]
            : ["--run", runId, "--title", material.title, "--body", material.body];

        const point = await cli.entity([
          "checkpoint",
          "open",
          session.key,
          "--if-revision",
          String(session.revision),
          ...input,
        ]);

        expect(point.data).toMatchObject({
          kind: "intent",
          sessionId: session.id,
          runId,
          ...material,
        });
        expect(await cli.entity(["checkpoint", "get", point.key])).toEqual(point);
      });
    },
  );

  test("страница намерений возвращает открытый материал выбранной сессии", async () => {
    await withCliFixture(async (cli) => {
      const project = cli.createProject();
      const { session, intent } = await cli.withDatabase(project, createSessionWithIntent);

      const page = await cli.page(["session", "intents", session.key], entityValue);

      expect(page.data.items).toEqual([intent]);
      expect(page.meta.page).toMatchObject({ count: 1, total: 1, nextCursor: null });
    });
  });

  test("страница истории содержит намерение и результат в порядке сохранения", async () => {
    await withCliFixture(async (cli) => {
      const project = cli.createProject();
      const { session, intent, result } = await cli.withDatabase(project, async (db) => {
        const { session, runId, intent } = await createSessionWithIntent(db);
        const result = await new HistoryService(db).checkpoint(
          intent.id,
          "complete",
          {
            runId,
            title: "Проверено",
            body: "Полный результат",
          },
          { actor: "agent", ifRevision: session.revision },
        );
        return { session, intent, result };
      });

      const page = await cli.page(["session", "history", session.key], entityValue);

      expect(page.data.items).toEqual([intent, result]);
      expect(page.meta.page).toMatchObject({ count: 2, total: 2, nextCursor: null });
    });
  });

  test("завершение намерения сохраняет связанный результат и полный текст", async () => {
    await withCliFixture(async (cli) => {
      const project = cli.createProject();
      const { session, runId, intent } = await cli.withDatabase(project, createSessionWithIntent);
      const body = "# Полный результат\n\n  Значимый отступ\n";

      const result = await cli.entity([
        "checkpoint",
        "complete",
        intent.key,
        "--run",
        runId,
        "--title",
        "Проверено",
        "--body",
        body,
        "--if-revision",
        String(session.revision),
      ]);

      expect(result.data).toMatchObject({
        kind: "result",
        sessionId: session.id,
        intentId: intent.id,
        runId,
        title: "Проверено",
        body,
      });
      expect(await cli.entity(["checkpoint", "get", result.key])).toEqual(result);
      const intents = await cli.page(["session", "intents", session.key], entityValue);
      expect(intents.data.items).toEqual([]);
    });
  });

  test("завершение сессии сохраняет итог и закрывает текущее участие", async () => {
    await withCliFixture(async (cli) => {
      const project = cli.createProject();
      const session = await cli.withDatabase(
        project,
        async (db) => await new HistoryService(db).start({ title: "Поручение" }, "agent"),
      );
      const runId = stringValue(session.data.currentRunId);

      const completed = await cli.entity([
        "session",
        "complete",
        session.key,
        "--run",
        runId,
        "--result",
        "Поручение выполнено",
        "--if-revision",
        String(session.revision),
      ]);

      expect(completed.data).toMatchObject({
        status: "completed",
        currentRunId: null,
        result: "Поручение выполнено",
      });
      expect(arrayValue(completed.data.runs).map(objectValue)).toEqual([
        expect.objectContaining({ id: runId, state: "completed" }),
      ]);
      expect(await cli.entity(["session", "get", session.key])).toEqual(completed);
    });
  });
});
