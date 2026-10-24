import { describe, expect, test } from "bun:test";
import { HistoryService, KnowledgeService, TasksService } from "@relay/core";
import type { ProjectDatabase } from "@relay/storage";
import { withCliFixture } from "./helpers/cli-fixture";
import {
  arrayValue,
  entityValue,
  objectValue,
  readEntitiesValue,
  stringValue,
} from "./helpers/responses";

const validDoctorContexts = [
  { name: "знания", seed: seedKnowledgeLinks },
  { name: "история", seed: seedCompletedHistory },
] as const;

/**
 * Создаёт согласованные участие приложения и документ раздела со ссылкой на фичу.
 * Соединение принадлежит вызывающей fixture и здесь не закрывается.
 */
async function seedKnowledgeLinks(db: ProjectDatabase): Promise<void> {
  const knowledge = new KnowledgeService(db);
  const feature = await knowledge.create("feature", { name: "Фича" }, "agent");
  const app = await knowledge.create("application", { name: "Web", slug: "web" }, "agent");
  await knowledge.replaceParticipation(app.id, [feature.id], {
    actor: "agent",
    ifRevision: app.revision,
  });
  await knowledge.changeSection(
    "create",
    { id: "rules", name: "Правила" },
    {
      actor: "agent",
      ifRevision: knowledge.get("project").revision,
    },
  );
  await knowledge.create(
    "document",
    { name: "Материал", body: "Текст", sectionId: "rules", targets: [feature.id] },
    "agent",
  );
}

/**
 * Создаёт завершённую сессию с намерением и результатом для проверки согласованности истории.
 * Все записи выполняются через Core; соединение остаётся у вызывающей fixture.
 */
async function seedCompletedHistory(db: ProjectDatabase): Promise<void> {
  const history = new HistoryService(db);
  const session = await history.start({ title: "Поручение" }, "agent");
  const runId = stringValue(session.data.currentRunId);
  const intent = await history.checkpoint(
    session.id,
    "open",
    {
      title: "Намерение",
      body: "Описание",
      runId,
    },
    { actor: "agent", ifRevision: session.revision },
  );
  await history.checkpoint(
    intent.id,
    "complete",
    {
      title: "Результат",
      body: "Материал",
      runId,
    },
    { actor: "agent", ifRevision: history.get(session.id).revision },
  );
  await history.transition(
    session.id,
    "complete",
    { result: "Итог", runId },
    {
      actor: "agent",
      ifRevision: history.get(session.id).revision,
    },
  );
}

describe("Поиск и обзор через CLI", () => {
  test("get разрешает типизированный постоянный ID задачи", async () => {
    await withCliFixture(async (cli) => {
      const project = cli.createProject();
      const task = await cli.withDatabase(
        project,
        async (db) => await new TasksService(db).create({ title: "Задача" }, "agent"),
      );

      const resolved = readEntitiesValue((await cli.success(["get", `task:${task.id}`])).data);

      expect(resolved).toHaveLength(1);
      expect(resolved[0]?.id).toBe(task.id);
    }, "get-batch");
  });

  test("get разрешает типизированный прежний ключ фичи", async () => {
    await withCliFixture(async (cli) => {
      const project = cli.createProject();
      const feature = await cli.withDatabase(project, async (db) => {
        const knowledge = new KnowledgeService(db);
        const feature = await knowledge.create("feature", { name: "Фича" }, "agent");
        await knowledge.rename("feature", feature.id, "FEATURE-RENAMED", {
          actor: "agent",
          ifRevision: feature.revision,
        });
        return feature;
      });

      const resolved = readEntitiesValue(
        (await cli.success(["get", `feature:${feature.key}`])).data,
      );

      expect(resolved).toHaveLength(1);
      expect(resolved[0]?.id).toBe(feature.id);
      expect(resolved[0]?.key).toBe("FEATURE-RENAMED");
    }, "get-batch");
  });

  test("поиск по прежнему ключу находит переименованную фичу", async () => {
    await withCliFixture(async (cli) => {
      const project = cli.createProject();
      const feature = await cli.withDatabase(project, async (db) => {
        const knowledge = new KnowledgeService(db);
        const feature = await knowledge.create("feature", { name: "Фича" }, "agent");
        await knowledge.rename("feature", feature.id, "FEATURE-RENAMED", {
          actor: "agent",
          ifRevision: feature.revision,
        });
        return feature;
      });

      const found = await cli.page(["search", "--q", feature.key], entityValue);

      expect(found.data.items.map((item) => item.id)).toEqual([feature.id]);
    });
  });

  test("поиск не включает текст комментариев в содержание задачи", async () => {
    await withCliFixture(async (cli) => {
      const project = cli.createProject();
      await cli.withDatabase(project, async (db) => {
        const tasks = new TasksService(db);
        const task = await tasks.create({ title: "Работа" }, "agent");
        await tasks.comment(task.id, "неискомый-комментарий", "agent");
      });

      const found = await cli.page(["search", "--q", "неискомый-комментарий"], entityValue);

      expect(found.meta.page.total).toBe(0);
      expect(found.data.items).toEqual([]);
    });
  });

  test("поиск документов учитывает пояснение прикрепления к требованию", async () => {
    await withCliFixture(async (cli) => {
      const project = cli.createProject();
      const document = await cli.withDatabase(project, async (db) => {
        const knowledge = new KnowledgeService(db);
        const feature = await knowledge.create("feature", { name: "Фича" }, "agent");
        const document = await knowledge.create(
          "document",
          { name: "Материал", body: "Текст" },
          "agent",
        );
        return await knowledge.linkDocument(document.id, feature.id, {
          actor: "agent",
          ifRevision: document.revision,
          description: "Особое основание",
        });
      });

      const found = await cli.page(
        ["search", "--q", "Особое основание", "--kind", "document"],
        entityValue,
      );

      expect(found.data.items.map((item) => item.id)).toEqual([document.id]);
    });
  });

  test("overview считает полный состав независимо от размера страницы", async () => {
    await withCliFixture(async (cli) => {
      const project = cli.createProject();
      await cli.withDatabase(project, async (db) => {
        await new KnowledgeService(db).create("feature", { name: "Фича" }, "agent");
        await new TasksService(db).create({ title: "Работа" }, "agent");
      });

      const overview = await cli.page(["overview", "--limit", "1"], entityValue);

      expect(overview.data.items).toHaveLength(1);
      expect(overview.data.counts).toMatchObject({ task: 1, feature: 1 });
      expect(overview.meta.page.total).toBe(cli.withDatabase(project, (db) => db.list().length));
    });
  });

  test("storage status представляет расположение и идентичность выбранной базы", async () => {
    await withCliFixture(async (cli) => {
      const project = cli.createProject();

      const answer = await cli.success(["storage", "status"]);

      expect(objectValue(answer.data)).toMatchObject({
        projectId: project.projectId,
        databasePath: project.databasePath,
      });
    });
  });
});

describe("Диагностика целостности через CLI", () => {
  test.each(validDoctorContexts)(
    "$name: согласованные данные проходят doctor без замечаний",
    async ({ seed }) => {
      await withCliFixture(async (cli) => {
        const project = cli.createProject();
        await cli.withDatabase(project, seed);

        const check = await cli.success(["doctor", "check"]);

        expect(objectValue(check.data)).toMatchObject({
          projectId: project.projectId,
          valid: true,
          issues: [],
        });
      });
    },
  );

  test("нарушенная ссылка возвращает INTEGRITY_ERROR в stderr без изменения данных", async () => {
    await withCliFixture(async (cli) => {
      const project = cli.createProject();
      const { generation, damaged } = await cli.withDatabase(project, async (db) => {
        const document = await new KnowledgeService(db).create(
          "document",
          { name: "Материал", body: "Текст" },
          "agent",
        );
        // Ошибка хранения вводится явно: штатный Core не позволяет записать такую ссылку.
        const damaged = {
          ...document,
          revision: document.revision + 1,
          data: { ...document.data, targets: ["missing-target"] },
        };
        db.update(damaged, document.revision);
        return { generation: db.getGeneration(), damaged };
      });

      const error = await cli.error(["doctor", "check"], 1);

      expect(error.code).toBe("INTEGRITY_ERROR");
      const issues = arrayValue(objectValue(error.details).issues).map(stringValue);
      expect(issues.some((issue) => issue.includes("missing-target"))).toBe(true);
      expect(cli.withDatabase(project, (db) => db.getGeneration())).toBe(generation);
      expect(cli.withDatabase(project, (db) => db.get(damaged.id))).toEqual(damaged);
    });
  });
});
