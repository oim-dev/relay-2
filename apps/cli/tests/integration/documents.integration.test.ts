import { expect, test } from "bun:test";
import { KnowledgeService } from "@relay/core";
import { withCliFixture } from "./helpers/cli-fixture";
import { objectValue } from "./helpers/responses";

test("новый проект имеет пустой список разделов, а create добавляет раздел и меняет ревизию", () =>
  withCliFixture(async (cli) => {
    const project = cli.createProject();
    const before = cli.withDatabase(project, (db) => new KnowledgeService(db).get("project"));
    const empty = await cli.page(["document", "section", "list"], objectValue);
    expect(empty.data.items).toEqual([]);
    expect(empty.meta.page).toMatchObject({ count: 0, total: 0 });
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
  }));

test("document create передаёт section-id в принадлежность документа разделу", () =>
  withCliFixture(async (cli) => {
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
    expect(document.data).toMatchObject({ name: "Правила", body: "# Правила", sectionId: "rules" });
    expect(await cli.entity(["document", "get", document.id])).toEqual(document);
  }));

test("document link сохраняет типизированную цель и описание в списке связей", () =>
  withCliFixture(async (cli) => {
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
      { target: { kind: "feature", id: feature.id }, type: "documents", description: "Основание" },
    ]);
  }));
