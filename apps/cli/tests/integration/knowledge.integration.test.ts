import { describe, expect, test } from "bun:test";
import { KnowledgeService } from "@relay/core";
import { withCliFixture } from "./helpers/cli-fixture";
import { entityValue } from "./helpers/responses";

describe("CLI: знания", () => {
  test.each(["feature", "application"] as const)(
    "create %s передаёт название и Markdown в Core",
    (kind) =>
      withCliFixture(async (cli) => {
        const project = cli.createProject();
        const description = "# Требования\n\n    точный текст\n";
        const created = await cli.entity([
          kind,
          "create",
          "--name",
          "Описание",
          "--description",
          description,
          ...(kind === "application" ? ["--slug", "web"] : []),
        ]);
        expect(created).toMatchObject({
          kind,
          createdBy: "agent",
          data: { name: "Описание", description },
        });
        expect(cli.withDatabase(project, (db) => db.get(created.id))).toEqual(created);
      }),
  );

  test("rename сохраняет ID, старый алиас и полное Markdown-содержание фичи", async () => {
    await withCliFixture(async (cli) => {
      const project = cli.createProject();
      const description = "# Требования\n\n    точный текст\n";
      const feature = cli.withDatabase(project, (db) =>
        new KnowledgeService(db).create("feature", { name: "Поиск", description }, "fixture"),
      );
      const renamed = await cli.entity([
        "feature",
        "rename",
        feature.key,
        "SEARCH",
        "--if-revision",
        String(feature.revision),
      ]);

      expect(renamed).toMatchObject({
        id: feature.id,
        key: "SEARCH",
        revision: feature.revision + 1,
        data: { description },
      });
      expect(await cli.entity(["feature", "get", feature.key])).toEqual(renamed);
      expect(await cli.entity(["feature", "get", renamed.key])).toEqual(renamed);
      const text = await cli.invoke(["feature", "get", feature.key]);
      expect(text).toMatchObject({ code: 0, stderr: "" });
      expect(text.stdout).toContain(description);
    });
  });

  test("update отклоняет устаревшую ревизию и сохраняет актуальную запись", async () => {
    await withCliFixture(async (cli) => {
      const project = cli.createProject();
      const { before, current } = cli.withDatabase(project, (db) => {
        const knowledge = new KnowledgeService(db);
        const before = knowledge.create("feature", { name: "Поиск" }, "fixture");
        const current = knowledge.rename("feature", before.id, "SEARCH", {
          actor: "fixture",
          ifRevision: before.revision,
        });
        return { before, current };
      });
      const error = await cli.error(
        [
          "feature",
          "update",
          current.key,
          "--summary",
          "Не сохранять",
          "--if-revision",
          String(before.revision),
        ],
        4,
      );

      expect(error).toMatchObject({
        code: "REVISION_CONFLICT",
        details: {
          id: current.id,
          expectedRevision: before.revision,
          actualRevision: current.revision,
        },
      });
      expect(await cli.entity(["feature", "get", current.key])).toEqual(current);
    });
  });

  test("update без ревизии отклоняется до изменения фичи", async () => {
    await withCliFixture(async (cli) => {
      const project = cli.createProject();
      const feature = cli.withDatabase(project, (db) =>
        new KnowledgeService(db).create("feature", { name: "Поиск" }, "fixture"),
      );

      expect(
        await cli.error(["feature", "update", feature.key, "--summary", "Не сохранять"], 2),
      ).toMatchObject({ code: "INVALID_ARGUMENT" });
      expect(await cli.entity(["feature", "get", feature.key])).toEqual(feature);
    });
  });

  test("get отсутствующей фичи возвращает NOT_FOUND и код завершения 3", async () => {
    await withCliFixture(async (cli) => {
      cli.createProject();
      expect(await cli.error(["feature", "get", "absent"], 3)).toMatchObject({
        code: "NOT_FOUND",
        details: { ref: "absent", kind: "feature" },
      });
    });
  });

  test.each([
    {
      name: "двоеточие в ключе",
      key: "application:foreign",
      exit: 2,
      code: "VALIDATION_ERROR",
      details: { field: "key" },
    },
    {
      name: "slug чужого приложения",
      key: "backend",
      exit: 4,
      code: "CONFLICT",
      details: { kind: "application", ref: "backend" },
    },
  ])("rename отклоняет $name, сохраняя адреса приложений", async ({ key, exit, code, details }) => {
    await withCliFixture(async (cli) => {
      const project = cli.createProject();
      const { first, second } = cli.withDatabase(project, (db) => {
        const knowledge = new KnowledgeService(db);
        return {
          first: knowledge.create("application", { name: "Web", slug: "web" }, "fixture"),
          second: knowledge.create("application", { name: "Backend", slug: "backend" }, "fixture"),
        };
      });

      expect(
        await cli.error(
          ["application", "rename", first.key, key, "--if-revision", String(first.revision)],
          exit,
        ),
      ).toMatchObject({ code, details });
      expect(await cli.entity(["application", "get", first.id])).toEqual(first);
      expect(await cli.entity(["application", "get", `application:${second.id}`])).toEqual(second);
      expect(await cli.entity(["application", "get", "backend"])).toEqual(second);
    });
  });

  test("participation replace разрешает ключ фичи и возвращает состав с новой ревизией приложения", async () => {
    await withCliFixture(async (cli) => {
      const project = cli.createProject();
      const { feature, app } = cli.withDatabase(project, (db) => {
        const knowledge = new KnowledgeService(db);
        return {
          feature: knowledge.create("feature", { name: "Поиск" }, "fixture"),
          app: knowledge.create("application", { name: "Web", slug: "web" }, "fixture"),
        };
      });
      const participation = await cli.entity([
        "application",
        "participation",
        "replace",
        app.key,
        "--targets",
        feature.key,
        "--if-revision",
        String(app.revision),
      ]);
      const list = await cli.page(["application", "participation", "list", app.key], entityValue);

      expect(participation.revision).toBe(app.revision + 1);
      expect(list.meta.page.total).toBe(1);
      expect(list.data).toMatchObject({ application: app.key, revision: participation.revision });
      expect(list.data.items[0]).toMatchObject({
        kind: "implementation",
        data: { applicationId: app.id, targetId: feature.id, targetKind: "feature", active: true },
      });
      expect(participation.data.implementationIds).toEqual(list.data.items.map((item) => item.id));
    });
  });
});
