import { describe, expect, test } from "bun:test";
import { KnowledgeService } from "@relay/core";
import { withCliFixture } from "./helpers/cli-fixture";
import { entityValue, objectValue, stringValue } from "./helpers/responses";

const invalidSectionFilters = [
  {
    name: "пустой section-id",
    flags: ["--section-id", ""],
    code: "INVALID_ARGUMENT",
  },
  {
    name: "одновременно without-section и section-id",
    flags: ["--without-section", "--section-id", "none"],
    code: "CONFLICTING_OPTIONS",
  },
  {
    name: "одновременно without-section и пустой section-id",
    flags: ["--without-section", "--section-id", ""],
    code: "CONFLICTING_OPTIONS",
  },
] as const;

describe("Документы и разделы через CLI", () => {
  test("новый проект возвращает пустую страницу разделов", async () => {
    await withCliFixture(async (cli) => {
      cli.createProject();

      const empty = await cli.page(["document", "section", "list"], objectValue);

      expect(empty.data.items).toEqual([]);
      expect(empty.meta.page).toMatchObject({ count: 0, total: 0 });
    });
  });

  test("создание раздела меняет ревизию проекта и публикует раздел в списке", async () => {
    await withCliFixture(async (cli) => {
      const project = cli.createProject();
      const before = cli.withDatabase(project, (db) => new KnowledgeService(db).get("project"));

      const updated = await cli.entity([
        "document",
        "section",
        "create",
        "rules",
        "--name",
        "Правила",
        "--if-revision",
        String(before.revision),
      ]);

      const sections = await cli.page(["document", "section", "list"], objectValue);
      expect(updated).toMatchObject({
        id: before.id,
        kind: "project",
        revision: before.revision + 1,
      });
      expect(sections.data).toMatchObject({ project: before.key, revision: updated.revision });
      expect(sections.data.items).toEqual([{ id: "rules", name: "Правила" }]);
      expect(sections.meta.page.total).toBe(1);
    });
  });

  test("section-id при создании документа сохраняет его принадлежность разделу", async () => {
    await withCliFixture(async (cli) => {
      const project = cli.createProject();
      cli.withDatabase(project, (db) => {
        const knowledge = new KnowledgeService(db);
        knowledge.changeSection(
          "create",
          { id: "rules", name: "Правила" },
          {
            actor: "fixture",
            ifRevision: knowledge.get("project").revision,
          },
        );
      });

      const document = await cli.entity([
        "document",
        "create",
        "--name",
        "Правила",
        "--body",
        "# Правила",
        "--section-id",
        "rules",
      ]);

      expect(document.data).toMatchObject({
        name: "Правила",
        body: "# Правила",
        sectionId: "rules",
      });
      expect(await cli.entity(["document", "get", document.id])).toEqual(document);
    });
  });

  test("without-section выбирает null и удалённые разделы до пагинации, сохраняя буквальный none", async () => {
    await withCliFixture(async (cli) => {
      const project = cli.createProject();
      const { unsectioned, retired, assigned } = cli.withDatabase(project, (db) => {
        const knowledge = new KnowledgeService(db);
        const firstSection = knowledge.changeSection(
          "create",
          { id: "none", name: "Буквальный ID none" },
          { actor: "fixture", ifRevision: knowledge.get("project").revision },
        );
        const secondSection = knowledge.changeSection(
          "create",
          { id: "retired", name: "Удаляемый раздел" },
          { actor: "fixture", ifRevision: firstSection.revision },
        );
        const unsectioned = knowledge.create(
          "document",
          { name: "Б. Без раздела", body: "Прямой null", sectionId: null },
          "fixture",
        );
        const assigned = knowledge.create(
          "document",
          { name: "В. Буквальный раздел", body: "ID none", sectionId: "none" },
          "fixture",
        );
        const retired = knowledge.create(
          "document",
          { name: "А. Из удалённого раздела", body: "Сохранённый документ", sectionId: "retired" },
          "fixture",
        );
        knowledge.changeSection(
          "remove",
          { id: "retired" },
          { actor: "fixture", ifRevision: secondSection.revision },
        );
        return { unsectioned, retired, assigned };
      });

      const first = await cli.page(
        ["document", "list", "--without-section", "--sort", "title", "--limit", "1"],
        entityValue,
      );
      const last = await cli.page(
        [
          "document",
          "list",
          "--without-section=true",
          "--sort=title",
          `--config=${project.configPath}`,
          "--limit=1",
          `--cursor=${stringValue(first.meta.page.nextCursor)}`,
        ],
        entityValue,
      );
      const literal = await cli.page(["document", "list", "--section-id", "none"], entityValue);

      expect(first.data.items).toEqual([
        { ...retired, data: { ...retired.data, sectionId: null } },
      ]);
      expect(first.meta.page).toMatchObject({ count: 1, limit: 1, total: 2 });
      expect(first.meta.page.nextCommand).toContain("--without-section=true");
      expect(first.meta.page.nextCommand).toContain("--sort=title");
      expect(last.data.items).toEqual([unsectioned]);
      expect(last.meta.page).toMatchObject({
        count: 1,
        limit: 1,
        total: 2,
        nextCursor: null,
        nextCommand: null,
      });
      expect(literal.data.items).toEqual([assigned]);
      expect(literal.meta.page.total).toBe(1);
      const changedFilter = await cli.error(
        [
          "document",
          "list",
          "--without-section=false",
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

  test("without-section=false не ограничивает раздел и совместим с section-id", async () => {
    await withCliFixture(async (cli) => {
      const project = cli.createProject();
      const { unsectioned, assigned } = cli.withDatabase(project, (db) => {
        const knowledge = new KnowledgeService(db);
        knowledge.changeSection(
          "create",
          { id: "rules", name: "Правила" },
          { actor: "fixture", ifRevision: knowledge.get("project").revision },
        );
        return {
          unsectioned: knowledge.create("document", { name: "Общий", body: "Текст" }, "fixture"),
          assigned: knowledge.create(
            "document",
            { name: "Правила", body: "Текст", sectionId: "rules" },
            "fixture",
          ),
        };
      });

      const all = await cli.page(["document", "list", "--without-section=false"], entityValue);
      const section = await cli.page(
        ["document", "list", "--without-section=false", "--section-id", "rules"],
        entityValue,
      );

      expect(all.data.items).toEqual([unsectioned, assigned]);
      expect(all.meta.page.total).toBe(2);
      expect(section.data.items).toEqual([assigned]);
      expect(section.meta.page.total).toBe(1);
    });
  });

  test("without-section возвращает пустую страницу, если все документы прикреплены к разделу", async () => {
    await withCliFixture(async (cli) => {
      const project = cli.createProject();
      cli.withDatabase(project, (db) => {
        const knowledge = new KnowledgeService(db);
        knowledge.changeSection(
          "create",
          { id: "rules", name: "Правила" },
          { actor: "fixture", ifRevision: knowledge.get("project").revision },
        );
        knowledge.create(
          "document",
          { name: "Правила", body: "Текст", sectionId: "rules" },
          "fixture",
        );
      });

      const empty = await cli.page(["document", "list", "--without-section"], entityValue);

      expect(empty.data.items).toEqual([]);
      expect(empty.meta.page).toMatchObject({
        count: 0,
        total: 0,
        nextCursor: null,
        nextCommand: null,
      });
    });
  });

  test.each(invalidSectionFilters)("$name отклоняется", async ({ flags, code }) => {
    await withCliFixture(async (cli) => {
      cli.createProject();

      const error = await cli.error(["document", "list", ...flags], 2);

      expect(error.code).toBe(code);
    });
  });

  test("прикрепление документа сохраняет типизированную цель и пояснение в списке связей", async () => {
    await withCliFixture(async (cli) => {
      const project = cli.createProject();
      const { document, feature } = cli.withDatabase(project, (db) => {
        const knowledge = new KnowledgeService(db);
        return {
          document: knowledge.create("document", { name: "Правила", body: "# Правила" }, "fixture"),
          feature: knowledge.create("feature", { name: "Поиск" }, "fixture"),
        };
      });

      const linked = await cli.entity([
        "document",
        "link",
        document.key,
        "--target",
        feature.key,
        "--description",
        "Основание",
        "--if-revision",
        String(document.revision),
      ]);

      const links = await cli.page(["document", "links", document.key], objectValue);
      expect(linked.revision).toBe(document.revision + 1);
      expect(links.data).toMatchObject({ ref: document.key, revision: linked.revision });
      expect(links.meta.page.total).toBe(1);
      expect(links.data.items).toEqual([
        {
          target: { kind: "feature", id: feature.id },
          type: "documents",
          description: "Основание",
        },
      ]);
    });
  });
});
