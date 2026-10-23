import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { relative } from "node:path";
import { HistoryService, KnowledgeService, QueryService, TasksService } from "@relay/core";
import { initializeWorkspace, registerProject } from "@relay/project-runtime";
import { withCliFixture } from "./helpers/cli-fixture";
import { entityValue, objectValue, stringValue } from "./helpers/responses";

describe("Подключение предметных макетов CLI", () => {
  test("config get в text показывает выбранные пути и отличает относительное переопределение", async () => {
    await withCliFixture(async (cli) => {
      const project = cli.createProject();
      const config = {
        version: 1,
        projectId: project.projectId,
        databasePath: relative(cli.runtime.cwd, project.databasePath),
        note: "  Значимые пробелы  ",
      };
      writeFileSync(project.configPath, JSON.stringify(config));

      const text = await cli.invoke(["config", "get"]);
      const json = await cli.success(["config", "get"]);

      expect(text).toMatchObject({ code: 0, stderr: "" });
      expect(text.stdout).toContain(
        `Путь базы в конфиге (переопределение): ${config.databasePath}\n`,
      );
      expect(text.stdout).toContain(`Конфигурация: ${project.configPath}\n`);
      expect(text.stdout).toContain(`База данных: ${project.databasePath}\n`);
      expect(text.stdout).toContain("note:   Значимые пробелы  \n");
      expect(json).toEqual({ data: config, meta: { ...project } });
    });
  });

  test("workspace list подключает строку регистрации без второго имени", async () => {
    await withCliFixture(async (cli) => {
      cli.createProject();
      const options = { cwd: cli.root, home: stringValue(cli.runtime.env.RELAY_HOME) };
      initializeWorkspace(options);
      registerProject(options, "commerce", cli.runtime.cwd);

      const text = await cli.invoke(["workspace", "project", "list"], { cwd: cli.root });

      expect(text).toEqual({
        code: 0,
        stdout: `commerce · ${cli.runtime.cwd}\n\nПоказано 1 из 1.\n`,
        stderr: "",
      });
    });
  });

  test("task comment list показывает полное тело и автора только текущей страницы", async () => {
    await withCliFixture(async (cli) => {
      const project = cli.createProject();
      const body = "\n## Обсуждение\n\n    код  \n";
      const { task, comments } = cli.withDatabase(project, (db) => {
        const tasks = new TasksService(db);
        const task = tasks.create({ title: "Обсуждаемая работа" }, "fixture");
        tasks.comment(task.id, body, "writer-1");
        tasks.comment(task.id, "Следующая страница", "writer-2");
        return { task, comments: tasks.comments(task.id) };
      });

      const text = await cli.invoke(["task", "comment", "list", task.key, "--limit", "1"]);
      const json = await cli.page(
        ["task", "comment", "list", task.key, "--limit", "1"],
        objectValue,
      );

      expect(text).toMatchObject({ code: 0, stderr: "" });
      expect(text.stdout).toContain(
        `Задача: ${task.key}\nРевизия: ${task.revision}\n\nКомментарий: `,
      );
      expect(text.stdout).toContain("Автор: writer-1\n");
      expect(text.stdout).toContain(
        `Содержание:\n${body}\n\nПоказано 1 из 2.\nПродолжение: relay task comment list ${task.key} `,
      );
      expect(text.stdout).not.toContain("Следующая страница");
      expect(json.data.items).toEqual(comments.slice(0, 1));
      expect(json.meta.page).toMatchObject({ count: 1, total: 2, limit: 1 });
    });
  });

  test("session tree сохраняет ID родителя за пределами страницы и завершает выдачу честно", async () => {
    await withCliFixture(async (cli) => {
      const project = cli.createProject();
      const { root, child } = cli.withDatabase(project, (db) => {
        const history = new HistoryService(db);
        const started = history.start({ title: "Общая работа" }, "agent");
        const runId = stringValue(started.data.currentRunId);
        const intent = history.checkpoint(
          started.id,
          "open",
          { runId, title: "Намерение", body: "Делегировать проверку" },
          { actor: "agent", ifRevision: started.revision },
        );
        const child = history.transition(
          intent.id,
          "fork",
          { runId, title: "Дочерняя проверка" },
          { actor: "agent", ifRevision: intent.data.sessionRevision },
        );
        return { root: history.get(started.id), child };
      });
      const first = await cli.page(["session", "tree", root.key, "--limit", "1"], entityValue);
      const cursor = stringValue(first.meta.page.nextCursor);

      const text = await cli.invoke(["session", "tree", root.key, "--cursor", cursor]);
      const json = await cli.page(["session", "tree", root.key, "--cursor", cursor], entityValue);

      expect(text).toEqual({
        code: 0,
        stdout:
          `${child.key} · Дочерняя проверка · ревизия ${child.revision} · ${child.data.status}\n` +
          `  Родительская сессия (ID, вне страницы): ${root.id}\n\nПоказано 1 из 2.\n`,
        stderr: "",
      });
      expect(json.data.items).toEqual([child]);
      expect(json.meta.page).toMatchObject({
        count: 1,
        total: 2,
        nextCursor: null,
        nextCommand: null,
      });
    });
  });

  test("overview сохраняет глобальную сводку при ограниченной карте и не меняет JSON", async () => {
    await withCliFixture(async (cli) => {
      const project = cli.createProject();
      const { items, ...overview } = cli.withDatabase(project, (db) => {
        new KnowledgeService(db).create(
          "document",
          { name: "Инструкция", body: "Полный документ" },
          "agent",
        );
        return new QueryService(db).overview();
      });

      const text = await cli.invoke(["overview", "--limit", "1"]);
      const json = await cli.success(["overview", "--limit", "1"]);

      expect(text).toMatchObject({ code: 0, stderr: "" });
      expect(text.stdout).toContain(
        "Сводка проекта\nPROJECT · Проверка CLI · ревизия 1 · поколение ",
      );
      expect(text.stdout).toContain("Записей: 4\n");
      expect(text.stdout).toContain("Доски 1 · Документы 1\n");
      expect(text.stdout).toContain(
        "\n\nКарта — 1 из 4\nBOARD-PRODUCT [board] · Продукт · ревизия 1\n",
      );
      expect(text.stdout).toContain("Продолжение: relay overview ");
      expect(text.stdout).not.toContain("Автор создания:");
      expect(json.data).toEqual({ ...overview, items: items.slice(0, 1) });
    });
  });

  test("init help объясняет системное авторство без настроенного проекта", async () => {
    await withCliFixture(async (cli) => {
      const help = await cli.invoke(["init", "--help"], { env: {} });

      expect(help).toMatchObject({ code: 0, stderr: "" });
      expect(help.stdout).toContain(
        "Начальные записи создаются от system независимо от --actor и RELAY_ACTOR",
      );
      expect(help.stdout).toContain("автор для init не требуется");
    });
  });
});
