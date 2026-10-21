import { expect, spyOn, test } from "bun:test";
import { join } from "node:path";
import { KnowledgeService, TasksService } from "@relay/core";
import { ProjectDatabase } from "@relay/storage";
import { withCliFixture } from "./helpers/cli-fixture";
import { entityValue, stringValue } from "./helpers/responses";

function seedDocuments(db: ProjectDatabase): void {
  const knowledge = new KnowledgeService(db);
  for (let index = 0; index < 3; index++)
    knowledge.create("document", { name: `Документ ${index}`, body: "Содержание" }, "agent");
}

test("курсор продолжает список без повторов и сохраняет размер страницы", () =>
  withCliFixture(async (cli) => {
    const project = cli.createProject();
    cli.withDatabase(project, seedDocuments);
    const first = await cli.page(["document", "list", "--limit", "1"], entityValue);
    const second = await cli.page(
      ["document", "list", "--cursor", stringValue(first.meta.page.nextCursor)],
      entityValue,
    );
    expect(first.meta.page.total).toBe(3);
    expect(second.meta.page.count).toBe(1);
    expect(second.meta.page.limit).toBe(first.meta.page.limit);
    expect(second.data.items[0]!.id).not.toBe(first.data.items[0]!.id);
    expect(first.meta.page.nextCommand).toContain(`--config=${project.configPath}`);
    const last = await cli.page(
      ["document", "list", "--cursor", stringValue(second.meta.page.nextCursor)],
      entityValue,
    );
    expect(new Set([first, second, last].map((page) => page.data.items[0]!.id)).size).toBe(3);
    expect(last.meta.page.nextCursor).toBeNull();
    expect(last.meta.page.nextCommand).toBeNull();
  }));

test.each(["task", "document"] as const)(
  "обычный список %s ограничивает чтение карточек выбранным окном",
  (kind) =>
    withCliFixture(async (cli) => {
      const project = cli.createProject();
      const records = cli.withDatabase(project, (db) => {
        const knowledge = new KnowledgeService(db);
        const tasks = new TasksService(db);
        return Array.from({ length: 3 }, (_, index) => {
          if (kind === "document")
            return knowledge.create(
              "document",
              { name: `Документ ${index}`, body: "Текст" },
              "agent",
            );
          const task = tasks.create({ title: `Задача ${index}`, description: "Текст" }, "agent");
          return tasks.comment(task.id, "Независимый комментарий", "agent");
        });
      });
      const fullRead = spyOn(ProjectDatabase.prototype, "list");
      const pageRead = spyOn(ProjectDatabase.prototype, "listPage");
      try {
        const page = await cli.page([kind, "list", "--limit", "1"], entityValue);
        expect(page.data.items).toEqual([records[0]!]);
        expect(page.meta.page.total).toBe(3);
        expect(pageRead).toHaveBeenCalledWith(kind, { offset: 0, limit: 1, sort: "key" });
        expect(
          fullRead.mock.calls.some(([selected]) => selected === kind || selected === undefined),
        ).toBe(false);
      } finally {
        fullRead.mockRestore();
        pageRead.mockRestore();
      }
    }),
);

test.each(["запрос", "проект", "поколение"] as const)(
  "курсор отклоняется, когда изменился %s",
  (variant) =>
    withCliFixture(async (cli) => {
      const project = cli.createProject();
      cli.withDatabase(project, seedDocuments);
      const first = await cli.page(["document", "list", "--limit", "1"], entityValue);
      const argv = ["document", "list", "--cursor", stringValue(first.meta.page.nextCursor)];
      let cwd = cli.runtime.cwd;
      if (variant === "запрос") argv.push("--q", "другой");
      if (variant === "проект") {
        cwd = join(cli.root, "other");
        cli.createProject(cwd);
      }
      if (variant === "поколение")
        cli.withDatabase(project, (db) =>
          new TasksService(db).create({ title: "Новое поколение" }, "agent"),
        );
      const error = await cli.error(argv, variant === "поколение" ? 4 : 2, { cwd });
      expect(error.code).toBe(variant === "поколение" ? "SNAPSHOT_CONFLICT" : "INVALID_CURSOR");
    }),
);
