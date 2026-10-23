import { describe, expect, test } from "bun:test";
import { KnowledgeService } from "@relay/core";
import { withCliFixture } from "./helpers/cli-fixture";
import { entityValue, stringValue } from "./helpers/responses";

const invalidFilters = [
  { name: "пустой тип приложения", argv: ["application", "list", "--type", ""] },
  { name: "неизвестный тип приложения", argv: ["application", "list", "--type", "unknown"] },
  { name: "пустая ссылка на приложение доски", argv: ["board", "list", "--application", ""] },
  {
    name: "пустая ссылка на фичу реализации",
    argv: ["implementation", "list", "--feature", ""],
  },
] as const;

describe("Фильтры знаний через CLI", () => {
  test("type выбирает приложения по типу до пагинации и сохраняется в продолжении", async () => {
    await withCliFixture(async (cli) => {
      const project = cli.createProject();
      const { accounts, orders } = cli.withDatabase(project, (db) => {
        const knowledge = new KnowledgeService(db);
        const orders = knowledge.create(
          "application",
          { name: "Заказы", slug: "orders", type: "backend" },
          "fixture",
        );
        knowledge.create(
          "application",
          { name: "Backend — панель", slug: "web", type: "frontend" },
          "fixture",
        );
        const accounts = knowledge.create(
          "application",
          { name: "Аккаунты", slug: "accounts", type: "backend" },
          "fixture",
        );
        return { accounts, orders };
      });

      const first = await cli.page(
        ["application", "list", "--type", "backend", "--sort", "title", "--limit", "1"],
        entityValue,
      );
      const last = await cli.page(
        [
          "application",
          "list",
          "--type=backend",
          "--sort=title",
          `--config=${project.configPath}`,
          "--limit=1",
          `--cursor=${stringValue(first.meta.page.nextCursor)}`,
        ],
        entityValue,
      );

      expect(first.data.items).toEqual([accounts]);
      expect(first.meta.page).toMatchObject({ count: 1, limit: 1, total: 2 });
      expect(first.meta.page.nextCommand).toContain("--type=backend");
      expect(first.meta.page.nextCommand).toContain("--sort=title");
      expect(first.meta.page.nextCommand).toContain(`--config=${project.configPath}`);
      expect(last.data.items).toEqual([orders]);
      expect(last.meta.page).toMatchObject({
        count: 1,
        limit: 1,
        total: 2,
        nextCursor: null,
        nextCommand: null,
      });
      const changedFilter = await cli.error(
        [
          "application",
          "list",
          "--type",
          "frontend",
          "--sort",
          "title",
          "--cursor",
          stringValue(first.meta.page.nextCursor),
        ],
        2,
      );
      expect(changedFilter.code).toBe("INVALID_CURSOR");
    });
  });

  test("несовпадающие type и q дают пустую страницу вместо поиска типа по тексту", async () => {
    await withCliFixture(async (cli) => {
      const project = cli.createProject();
      cli.withDatabase(project, (db) => {
        const knowledge = new KnowledgeService(db);
        knowledge.create("application", { name: "Backend", slug: "web" }, "fixture");
        knowledge.create(
          "application",
          { name: "Заказы", slug: "orders", type: "backend" },
          "fixture",
        );
      });

      const empty = await cli.page(
        ["application", "list", "--type", "backend", "--q", "Backend"],
        entityValue,
      );

      expect(empty.data.items).toEqual([]);
      expect(empty.meta.page).toMatchObject({
        count: 0,
        total: 0,
        nextCursor: null,
        nextCommand: null,
      });
    });
  });

  test("board --application разрешает алиас приложения и исключает продуктовую и чужую доски", async () => {
    await withCliFixture(async (cli) => {
      const project = cli.createProject();
      const { application, board } = cli.withDatabase(project, (db) => {
        const knowledge = new KnowledgeService(db);
        const application = knowledge.create(
          "application",
          { name: "Витрина", slug: "web" },
          "fixture",
        );
        knowledge.create("application", { name: "API", slug: "api" }, "fixture");
        knowledge.rename("application", application.id, "APP-WEB", {
          actor: "fixture",
          ifRevision: application.revision,
        });
        return { application, board: knowledge.get("board", application.data.boardId) };
      });

      const page = await cli.page(
        ["board", "list", "--application", `application:${application.key}`, "--limit", "1"],
        entityValue,
      );

      expect(page.data.items).toEqual([board]);
      expect(page.meta.page).toMatchObject({
        count: 1,
        total: 1,
        nextCursor: null,
        nextCommand: null,
      });
      const empty = await cli.page(
        ["board", "list", "--application", application.id, "--q", "Отсутствующее имя"],
        entityValue,
      );
      expect(empty.data.items).toEqual([]);
      expect(empty.meta.page).toMatchObject({ count: 0, total: 0, nextCursor: null });
    });
  });

  test("feature включает FI и SI выбранного приложения, сохраняя снятые реализации и продолжение", async () => {
    await withCliFixture(async (cli) => {
      const project = cli.createProject();
      const { app, feature, featureImplementation, scenarioImplementation } = cli.withDatabase(
        project,
        (db) => {
          const knowledge = new KnowledgeService(db);
          const feature = knowledge.create("feature", { name: "Поиск" }, "fixture");
          const scenario = knowledge.create(
            "scenario",
            { name: "Пустой результат", feature: feature.id },
            "fixture",
          );
          const otherFeature = knowledge.create("feature", { name: "Оплата" }, "fixture");
          const created = knowledge.create(
            "application",
            { name: "Витрина", slug: "web" },
            "fixture",
          );
          const active = knowledge.replaceParticipation(
            created.id,
            [feature.id, scenario.id, otherFeature.id],
            { actor: "fixture", ifRevision: created.revision },
          );
          const app = knowledge.replaceParticipation(active.id, [feature.id, otherFeature.id], {
            actor: "fixture",
            ifRevision: active.revision,
          });
          const otherApp = knowledge.create("application", { name: "API", slug: "api" }, "fixture");
          knowledge.replaceParticipation(otherApp.id, [feature.id, scenario.id], {
            actor: "fixture",
            ifRevision: otherApp.revision,
          });
          return {
            app,
            feature,
            featureImplementation: knowledge.get("implementation", "WEB-FI-1"),
            scenarioImplementation: knowledge.get("implementation", "WEB-SI-1"),
          };
        },
      );
      const filters = ["--application", app.key, "--feature", `feature:${feature.key}`];

      const first = await cli.page(
        ["implementation", "list", ...filters, "--limit", "1"],
        entityValue,
      );
      const last = await cli.page(
        ["implementation", "list", ...filters, "--cursor", stringValue(first.meta.page.nextCursor)],
        entityValue,
      );

      expect(first.data.items).toEqual([featureImplementation]);
      expect(first.meta.page).toMatchObject({ count: 1, limit: 1, total: 2 });
      expect(first.meta.page.nextCommand).toContain(`--feature=feature:${feature.key}`);
      expect(first.meta.page.nextCommand).toContain(`--application=${app.key}`);
      expect(last.data.items).toEqual([scenarioImplementation]);
      expect(last.data.items[0]?.data.active).toBe(false);
      expect(last.meta.page).toMatchObject({
        count: 1,
        limit: 1,
        total: 2,
        nextCursor: null,
        nextCommand: null,
      });
    });
  });

  test("feature и точный target пересекаются: чужая фича даёт пустой результат", async () => {
    await withCliFixture(async (cli) => {
      const project = cli.createProject();
      const { feature, scenario, otherFeature, implementation } = cli.withDatabase(
        project,
        (db) => {
          const knowledge = new KnowledgeService(db);
          const feature = knowledge.create("feature", { name: "Поиск" }, "fixture");
          const otherFeature = knowledge.create("feature", { name: "Оплата" }, "fixture");
          const scenario = knowledge.create(
            "scenario",
            { name: "Пустой результат", feature: feature.id },
            "fixture",
          );
          const app = knowledge.create("application", { name: "Витрина", slug: "web" }, "fixture");
          knowledge.replaceParticipation(app.id, [feature.id, scenario.id], {
            actor: "fixture",
            ifRevision: app.revision,
          });
          return {
            feature,
            scenario,
            otherFeature,
            implementation: knowledge.get("implementation", "WEB-SI-1"),
          };
        },
      );

      const exact = await cli.page(
        ["implementation", "list", "--feature", feature.id, "--target", scenario.key],
        entityValue,
      );
      const empty = await cli.page(
        ["implementation", "list", "--feature", otherFeature.key, "--target", scenario.key],
        entityValue,
      );

      expect(exact.data.items).toEqual([implementation]);
      expect(exact.meta.page.total).toBe(1);
      expect(empty.data.items).toEqual([]);
      expect(empty.meta.page).toMatchObject({
        count: 0,
        total: 0,
        nextCursor: null,
        nextCommand: null,
      });
    });
  });

  test.each(invalidFilters)("$name отклоняется как INVALID_ARGUMENT", async ({ argv }) => {
    await withCliFixture(async (cli) => {
      cli.createProject();

      const error = await cli.error(argv, 2);

      expect(error.code).toBe("INVALID_ARGUMENT");
    });
  });
});
