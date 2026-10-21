import { expect, test } from "bun:test";
import { HistoryService, KnowledgeService, TasksService } from "@relay/core";
import { withCliFixture } from "./helpers/cli-fixture";
import { arrayValue, entityValue, objectValue, stringValue } from "./helpers/responses";

test("search и inspect разрешают прежние ключи и типизированные адреса", () =>
  withCliFixture(async (cli) => {
    const project = cli.createProject();
    const { task, feature } = cli.withDatabase(project, (db) => {
      const knowledge = new KnowledgeService(db);
      const feature = knowledge.create("feature", { name: "Фича" }, "agent");
      knowledge.rename("feature", feature.id, "FEATURE-RENAMED", {
        actor: "agent",
        ifRevision: feature.revision,
      });
      return { feature, task: new TasksService(db).create({ title: "Задача" }, "agent") };
    });
    expect((await cli.entity(["inspect", "resolve", `task:${task.id}`])).id).toBe(task.id);
    expect((await cli.entity(["inspect", "get", `feature:${feature.key}`])).id).toBe(feature.id);
    const found = await cli.page(["search", "--q", feature.key], entityValue);
    expect(found.data.items.map((item) => item.id)).toEqual([feature.id]);
  }));

test("поиск не включает текст комментариев в содержание задачи", () =>
  withCliFixture(async (cli) => {
    const project = cli.createProject();
    cli.withDatabase(project, (db) => {
      const tasks = new TasksService(db);
      const task = tasks.create({ title: "Работа" }, "agent");
      tasks.comment(task.id, "неискомый-комментарий", "agent");
    });
    expect(
      (await cli.page(["search", "--q", "неискомый-комментарий"], entityValue)).meta.page.total,
    ).toBe(0);
  }));

test("поиск документов учитывает пояснение прикрепления к требованию", () =>
  withCliFixture(async (cli) => {
    const project = cli.createProject();
    const document = cli.withDatabase(project, (db) => {
      const knowledge = new KnowledgeService(db);
      const feature = knowledge.create("feature", { name: "Фича" }, "agent");
      const document = knowledge.create("document", { name: "Материал", body: "Текст" }, "agent");
      return knowledge.linkDocument(document.id, feature.id, {
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
  }));

test("overview считает полный состав независимо от размера страницы", () =>
  withCliFixture(async (cli) => {
    const project = cli.createProject();
    cli.withDatabase(project, (db) => {
      new KnowledgeService(db).create("feature", { name: "Фича" }, "agent");
      new TasksService(db).create({ title: "Работа" }, "agent");
    });
    const overview = await cli.page(["overview", "--limit", "1"], entityValue);
    expect(overview.data.items).toHaveLength(1);
    expect(overview.data.counts).toMatchObject({ task: 1, feature: 1 });
    expect(overview.meta.page.total).toBe(cli.withDatabase(project, (db) => db.list().length));
  }));

test("storage status представляет расположение и идентичность выбранной базы", () =>
  withCliFixture(async (cli) => {
    const project = cli.createProject();
    const status = objectValue((await cli.success(["storage", "status"])).data);
    expect(status).toMatchObject({
      projectId: project.projectId,
      databasePath: project.databasePath,
    });
  }));

test.each(["знания", "история"] as const)(
  "doctor принимает согласованные данные области %s",
  (area) =>
    withCliFixture(async (cli) => {
      const project = cli.createProject();
      cli.withDatabase(project, (db) => {
        if (area === "знания") {
          const knowledge = new KnowledgeService(db);
          const feature = knowledge.create("feature", { name: "Фича" }, "agent");
          const app = knowledge.create("application", { name: "Web", slug: "web" }, "agent");
          knowledge.replaceParticipation(app.id, [feature.id], {
            actor: "agent",
            ifRevision: app.revision,
          });
          knowledge.changeSection(
            "create",
            { id: "rules", name: "Правила" },
            { actor: "agent", ifRevision: knowledge.get("project").revision },
          );
          knowledge.create(
            "document",
            { name: "Материал", body: "Текст", sectionId: "rules", targets: [feature.id] },
            "agent",
          );
        } else {
          const history = new HistoryService(db);
          const session = history.start({ title: "Поручение" }, "agent");
          const runId = stringValue(session.data.currentRunId);
          const intent = history.checkpoint(
            session.id,
            "open",
            { title: "Намерение", body: "Описание", runId },
            { actor: "agent", ifRevision: session.revision },
          );
          history.checkpoint(
            intent.id,
            "complete",
            { title: "Результат", body: "Материал", runId },
            { actor: "agent", ifRevision: history.get(session.id).revision },
          );
          history.transition(
            session.id,
            "complete",
            { result: "Итог", runId },
            { actor: "agent", ifRevision: history.get(session.id).revision },
          );
        }
      });
      const check = objectValue((await cli.success(["doctor", "check"])).data);
      expect(check).toMatchObject({ projectId: project.projectId, valid: true, issues: [] });
    }),
);

test("doctor передаёт нарушение ссылок в stderr с предметным кодом и деталями", () =>
  withCliFixture(async (cli) => {
    const project = cli.createProject();
    const generation = cli.withDatabase(project, (db) => {
      const document = new KnowledgeService(db).create(
        "document",
        { name: "Материал", body: "Текст" },
        "agent",
      );
      // Ошибка хранения вводится явно: штатный Core не позволяет записать такую ссылку.
      db.update(
        {
          ...document,
          revision: document.revision + 1,
          data: { ...document.data, targets: ["missing-target"] },
        },
        document.revision,
      );
      return db.getGeneration();
    });
    const error = await cli.error(["doctor", "check"], 1);
    expect(error.code).toBe("INTEGRITY_ERROR");
    const issues = arrayValue(objectValue(error.details).issues).map(stringValue);
    expect(issues.some((issue) => issue.includes("missing-target"))).toBe(true);
    expect(cli.withDatabase(project, (db) => db.getGeneration())).toBe(generation);
  }));
