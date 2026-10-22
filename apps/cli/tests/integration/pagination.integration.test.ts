import { describe, expect, spyOn, test } from "bun:test";
import { dirname, join } from "node:path";
import type { EntityRecord } from "@relay/contracts";
import { KnowledgeService, TasksService } from "@relay/core";
import { initializeWorkspace, registerProject } from "@relay/project-runtime";
import { ProjectDatabase } from "@relay/storage";
import { withCliFixture } from "./helpers/cli-fixture";
import { entityValue, objectValue, stringValue } from "./helpers/responses";

const boundedLists = [
  { name: "документы", kind: "document", seed: seedDocuments },
  { name: "задачи с комментариями", kind: "task", seed: seedCommentedTasks },
] as const;

/**
 * Создаёт три документа в переданном соединении; соединением владеет fixture вызывающего теста.
 */
function seedDocuments(db: ProjectDatabase): EntityRecord[] {
  const knowledge = new KnowledgeService(db);
  return Array.from({ length: 3 }, (_, index) =>
    knowledge.create("document", { name: `Документ ${index}`, body: "Содержание" }, "agent"),
  );
}

/**
 * Создаёт три задачи с независимыми комментариями для проверки полноты ограниченного окна.
 * Соединение не закрывается: им владеет вызывающий тест.
 */
function seedCommentedTasks(db: ProjectDatabase): EntityRecord[] {
  const tasks = new TasksService(db);
  return Array.from({ length: 3 }, (_, index) => {
    const task = tasks.create({ title: `Задача ${index}`, description: "Текст" }, "agent");
    return tasks.comment(task.id, "Независимый комментарий", "agent");
  });
}

describe("Пагинация списков CLI", () => {
  test("курсор проходит весь список без повторов и сохраняет размер страницы", async () => {
    await withCliFixture(async (cli) => {
      const project = cli.createProject();
      const documents = cli.withDatabase(project, seedDocuments);

      const first = await cli.page(["document", "list", "--limit", "1"], entityValue);
      const second = await cli.page(
        ["document", "list", "--cursor", stringValue(first.meta.page.nextCursor)],
        entityValue,
      );
      const last = await cli.page(
        ["document", "list", "--cursor", stringValue(second.meta.page.nextCursor)],
        entityValue,
      );

      expect(first.meta.page.total).toBe(3);
      expect(second.meta.page.count).toBe(1);
      expect(second.meta.page.limit).toBe(first.meta.page.limit);
      expect(first.meta.page.nextCommand).toContain(`--config=${project.configPath}`);
      for (const page of [first, second, last]) {
        expect(page.data.items).toHaveLength(1);
        expect(page.meta.page).toMatchObject({ count: 1, limit: 1, total: 3 });
      }
      expect(
        [first, second, last].flatMap((page) => page.data.items.map((item) => item.id)),
      ).toEqual(documents.map((document) => document.id));
      expect(last.meta.page.nextCursor).toBeNull();
      expect(last.meta.page.nextCommand).toBeNull();
    });
  });

  test("nextCommand workspace с относительным config продолжает список через абсолютный путь", async () => {
    await withCliFixture(async (cli) => {
      const firstProject = cli.createProject();
      const secondProject = cli.createProject(join(cli.root, "other"));
      const cwd = join(cli.root, "workspace");
      const options = {
        cwd,
        home: stringValue(cli.runtime.env.RELAY_HOME),
        config: "registry.json",
      };
      const workspace = initializeWorkspace(options);
      registerProject(options, "alpha", dirname(firstProject.configPath));
      registerProject(options, "beta", dirname(secondProject.configPath));

      const first = await cli.page(
        ["workspace", "project", "list", "--config", options.config, "--limit", "1"],
        objectValue,
        { cwd },
      );
      const cursor = stringValue(first.meta.page.nextCursor);
      // Выполняем соответствующие nextCommand аргументы без процесса и собственного shell-parser.
      const last = await cli.page(
        [
          "workspace",
          "project",
          "list",
          "--config",
          workspace.configPath,
          "--limit",
          "1",
          "--cursor",
          cursor,
        ],
        objectValue,
        { cwd },
      );

      expect(first.data).toEqual({
        items: [{ name: "alpha", path: cli.runtime.cwd }],
      });
      expect(first.meta.page).toMatchObject({ count: 1, limit: 1, total: 2 });
      expect(first.meta.page.nextCommand).toContain(`--config=${workspace.configPath}`);
      expect(first.meta.page.nextCommand).toContain("--limit=1");
      expect(first.meta.page.nextCommand).toContain(`--cursor=${cursor}`);
      expect(last).toEqual({
        data: { items: [{ name: "beta", path: join(cli.root, "other") }] },
        meta: {
          page: {
            count: 1,
            limit: 1,
            total: 2,
            nextCursor: null,
            nextCommand: null,
            consistency: "snapshot",
          },
        },
      });
    });
  });

  test.each(boundedLists)(
    "$name: обычный список читает карточки только выбранного окна",
    async ({ kind, seed }) => {
      await withCliFixture(async (cli) => {
        const project = cli.createProject();
        const records = cli.withDatabase(project, seed);
        const fullRead = spyOn(ProjectDatabase.prototype, "list");
        const pageRead = spyOn(ProjectDatabase.prototype, "listPage");
        try {
          const page = await cli.page([kind, "list", "--limit", "1"], entityValue);

          expect(page.data.items).toEqual(records.slice(0, 1));
          expect(page.meta.page.total).toBe(3);
          expect(pageRead).toHaveBeenCalledWith(kind, { offset: 0, limit: 1, sort: "key" });
          expect(
            fullRead.mock.calls.some(([selected]) => selected === kind || selected === undefined),
          ).toBe(false);
        } finally {
          fullRead.mockRestore();
          pageRead.mockRestore();
        }
      });
    },
  );

  test("курсор другого запроса отклоняется с INVALID_CURSOR", async () => {
    await withCliFixture(async (cli) => {
      const project = cli.createProject();
      cli.withDatabase(project, seedDocuments);
      const first = await cli.page(["document", "list", "--limit", "1"], entityValue);

      const error = await cli.error(
        ["document", "list", "--cursor", stringValue(first.meta.page.nextCursor), "--q", "другой"],
        2,
      );

      expect(error.code).toBe("INVALID_CURSOR");
    });
  });

  test("курсор другого проекта отклоняется с INVALID_CURSOR", async () => {
    await withCliFixture(async (cli) => {
      const project = cli.createProject();
      cli.withDatabase(project, seedDocuments);
      const first = await cli.page(["document", "list", "--limit", "1"], entityValue);
      const cwd = join(cli.root, "other");
      cli.createProject(cwd);

      const error = await cli.error(
        ["document", "list", "--cursor", stringValue(first.meta.page.nextCursor)],
        2,
        { cwd },
      );

      expect(error.code).toBe("INVALID_CURSOR");
    });
  });

  test("курсор прошлого поколения отклоняется с SNAPSHOT_CONFLICT", async () => {
    await withCliFixture(async (cli) => {
      const project = cli.createProject();
      cli.withDatabase(project, seedDocuments);
      const first = await cli.page(["document", "list", "--limit", "1"], entityValue);
      cli.withDatabase(project, (db) =>
        new TasksService(db).create({ title: "Новое поколение" }, "agent"),
      );

      const error = await cli.error(
        ["document", "list", "--cursor", stringValue(first.meta.page.nextCursor)],
        4,
      );

      expect(error.code).toBe("SNAPSHOT_CONFLICT");
    });
  });
});
