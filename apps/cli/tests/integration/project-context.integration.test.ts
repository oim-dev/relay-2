import { expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { copyFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { initializeWorkspace, registerProject } from "@relay/project-runtime";
import { ProjectDatabase } from "@relay/storage";
import { withCliFixture } from "./helpers/cli-fixture";
import { entityValue, objectValue, stringValue } from "./helpers/responses";

test("init передаёт имя и slug в локальный проект и возвращает его расположение", () =>
  withCliFixture(async (cli) => {
    const data = objectValue(
      (await cli.success(["init", "--name", "Новый проект", "--slug", "new-project"])).data,
    );
    const project = {
      projectId: stringValue(data.projectId),
      databasePath: stringValue(data.databasePath),
      configPath: stringValue(data.configPath),
    };
    expect(cli.withDatabase(project, (db) => db.get(project.projectId)?.data)).toEqual({
      name: "Новый проект",
      slug: "new-project",
    });
    expect((await cli.entity(["project", "get"])).id).toBe(project.projectId);
  }));

test("чтения работают при занятом писателе, а запись сообщает STORAGE_BUSY", () =>
  withCliFixture(async (cli) => {
    const project = cli.createProject();
    const writer = new Database(project.databasePath);
    try {
      writer.exec("BEGIN IMMEDIATE");
      for (const argv of [
        ["overview"],
        ["task", "list"],
        ["search", "--q", "Проверка"],
        ["doctor", "check"],
      ]) {
        await cli.success(argv);
      }
      expect((await cli.error(["task", "create", "--title", "Ожидает писателя"], 4)).code).toBe(
        "STORAGE_BUSY",
      );
    } finally {
      if (writer.inTransaction) writer.exec("ROLLBACK");
      writer.close();
    }
    expect((await cli.page(["task", "list"], entityValue)).data.items).toEqual([]);
  }));

test("подмена базы между выбором и открытием не направляет запись в другой проект", () =>
  withCliFixture(async (cli) => {
    const project = cli.createProject();
    const revision = cli.withDatabase(project, (db) => db.get(project.projectId)!.revision);
    const foreignPath = join(cli.root, "foreign.sqlite");
    const foreign = ProjectDatabase.create(foreignPath, {
      id: crypto.randomUUID(),
      name: "Чужой",
      slug: "foreign",
    });
    const foreignId = foreign.projectId;
    foreign.close();
    const open = ProjectDatabase.open;
    let opens = 0;
    // Перехватывается только уникальный путь этой fixture; подмена восстанавливается до очистки файлов.
    const interception = spyOn(ProjectDatabase, "open").mockImplementation((path) => {
      if (path === project.databasePath && ++opens === 2) copyFileSync(foreignPath, path);
      return open(path);
    });
    try {
      const error = await cli.error(
        ["project", "update", "--name", "Не сохранять", "--if-revision", String(revision)],
        4,
      );
      expect(error.code).toBe("PROJECT_ID_MISMATCH");
      expect(error.details).toMatchObject({ expected: project.projectId, actual: foreignId });
    } finally {
      interception.mockRestore();
    }
    expect(cli.withDatabase(project, (db) => db.get("PROJECT")!.data.name)).toBe("Чужой");
  }));

test("селектор workspace выбирает нужный проект, отсутствие выбора диагностируется", () =>
  withCliFixture(async (cli) => {
    const first = cli.createProject();
    const second = cli.createProject(join(cli.root, "other"));
    const cwd = join(cli.root, "workspace");
    mkdirSync(cwd);
    initializeWorkspace({ cwd });
    registerProject({ cwd }, "one", first.configPath);
    registerProject({ cwd }, "two", second.configPath);
    expect((await cli.error(["project", "get"], 2, { cwd })).code).toBe("PROJECT_REQUIRED");
    expect((await cli.entity(["--project", "one", "project", "get"], { cwd })).id).toBe(
      first.projectId,
    );
    expect((await cli.entity(["project", "get", "--project", "two"], { cwd })).id).toBe(
      second.projectId,
    );
  }));

test("команды регистрации изменяют workspace, сохраняя зарегистрированный проект", () =>
  withCliFixture(async (cli) => {
    const project = cli.createProject();
    const cwd = join(cli.root, "workspace");
    mkdirSync(cwd);
    await cli.success(["workspace", "project", "init"], { cwd });
    await cli.success(["workspace", "project", "add", "one", project.configPath], { cwd });
    const registered = await cli.page(["workspace", "project", "list"], objectValue, { cwd });
    expect(registered.meta.page.total).toBe(1);
    expect(registered.data.items[0]).toMatchObject({ name: "one", configPath: project.configPath });
    await cli.success(["workspace", "project", "remove", "one"], { cwd });
    expect(
      (await cli.page(["workspace", "project", "list"], objectValue, { cwd })).data.items,
    ).toEqual([]);
    expect((await cli.entity(["project", "get"])).id).toBe(project.projectId);
  }));
