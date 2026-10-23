import { describe, expect, test } from "bun:test";
import { KnowledgeService } from "@relay/core";
import { withCliFixture } from "./helpers/cli-fixture";
import { entityValue } from "./helpers/responses";

const knowledgeCreation = [
  { name: "фича", kind: "feature", extra: [] },
  { name: "приложение", kind: "application", extra: ["--slug", "web"] },
] as const;
const invalidRenames = [
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
] as const;

describe("Знания через CLI", () => {
  test.each(knowledgeCreation)(
    "$name создаётся с переданными названием и полным Markdown",
    async ({ kind, extra }) => {
      await withCliFixture(async (cli) => {
        const project = cli.createProject();
        const description = "# Требования\n\n    точный текст\n";

        const created = await cli.entity([
          kind,
          "create",
          "--name",
          "Описание",
          "--description",
          description,
          ...extra,
        ]);

        expect(created).toMatchObject({
          kind,
          createdBy: "agent",
          data: { name: "Описание", description },
        });
        expect(cli.withDatabase(project, (db) => db.get(created.id))).toEqual(created);
      });
    },
  );

  test("цифровое начало slug с явным prefix создаёт приложение и связанную доску", async () => {
    await withCliFixture(async (cli) => {
      const project = cli.createProject();

      const application = await cli.entity([
        "application",
        "create",
        "--name",
        "Двухфакторная аутентификация",
        "--slug",
        "2fa",
        "--prefix",
        "MFA",
        "--type",
        "backend",
      ]);

      expect(application.data).toMatchObject({ slug: "2fa", prefix: "MFA", type: "backend" });
      cli.withDatabase(project, (db) => {
        const knowledge = new KnowledgeService(db);
        const board = knowledge.get("board", "2fa");
        expect(application.data.boardId).toBe(board.id);
        expect(board.data).toMatchObject({
          name: "Двухфакторная аутентификация",
          slug: "2fa",
          prefix: "MFA",
          applicationId: application.id,
        });
      });
    });
  });

  test("переименование фичи сохраняет ID, старый алиас и полное Markdown-содержание", async () => {
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

  test("обновление с устаревшей ревизией сохраняет актуальную запись и возвращает REVISION_CONFLICT", async () => {
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

  test("обновление без ревизии отклоняется до изменения фичи", async () => {
    await withCliFixture(async (cli) => {
      const project = cli.createProject();
      const feature = cli.withDatabase(project, (db) =>
        new KnowledgeService(db).create("feature", { name: "Поиск" }, "fixture"),
      );

      const error = await cli.error(
        ["feature", "update", feature.key, "--summary", "Не сохранять"],
        2,
      );

      expect(error.code).toBe("INVALID_ARGUMENT");
      expect(await cli.entity(["feature", "get", feature.key])).toEqual(feature);
    });
  });

  test("чтение отсутствующей фичи возвращает NOT_FOUND и код завершения 3", async () => {
    await withCliFixture(async (cli) => {
      cli.createProject();

      const error = await cli.error(["feature", "get", "absent"], 3);

      expect(error).toMatchObject({
        code: "NOT_FOUND",
        details: { ref: "absent", kind: "feature" },
      });
    });
  });

  test.each(invalidRenames)(
    "$name: переименование отклоняется, сохраняя адреса приложений",
    async ({ key, exit, code, details }) => {
      await withCliFixture(async (cli) => {
        const project = cli.createProject();
        const { first, second } = cli.withDatabase(project, (db) => {
          const knowledge = new KnowledgeService(db);
          return {
            first: knowledge.create("application", { name: "Web", slug: "web" }, "fixture"),
            second: knowledge.create(
              "application",
              { name: "Backend", slug: "backend" },
              "fixture",
            ),
          };
        });

        const error = await cli.error(
          ["application", "rename", first.key, key, "--if-revision", String(first.revision)],
          exit,
        );

        expect(error).toMatchObject({ code, details });
        expect(await cli.entity(["application", "get", first.id])).toEqual(first);
        expect(await cli.entity(["application", "get", `application:${second.id}`])).toEqual(
          second,
        );
        expect(await cli.entity(["application", "get", "backend"])).toEqual(second);
      });
    },
  );

  test("замена участия по ключу фичи возвращает состав с новой ревизией приложения", async () => {
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

  test("явный пустой targets в JSON очищает непустое участие приложения", async () => {
    await withCliFixture(async (cli) => {
      const project = cli.createProject();
      const app = cli.withDatabase(project, (db) => {
        const knowledge = new KnowledgeService(db);
        const feature = knowledge.create("feature", { name: "Поиск" }, "fixture");
        const created = knowledge.create("application", { name: "Web", slug: "web" }, "fixture");
        return knowledge.replaceParticipation(created.id, [feature.id], {
          actor: "fixture",
          ifRevision: created.revision,
        });
      });

      const cleared = await cli.entity([
        "application",
        "participation",
        "replace",
        app.key,
        "--input",
        '{"targets":[]}',
        "--if-revision",
        String(app.revision),
      ]);

      expect(cleared.id).toBe(app.id);
      expect(cleared.revision).toBe(app.revision + 1);
      expect(cleared.data).toEqual({ ...app.data, implementationIds: [] });
      cli.withDatabase(project, (db) => {
        const knowledge = new KnowledgeService(db);
        expect(db.get(app.id)).toEqual(cleared);
        expect(knowledge.list("implementation", { application: app.id, active: true })).toEqual([]);
      });
    });
  });
});
