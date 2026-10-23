import { describe, expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { copyFileSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { KnowledgeService } from "@relay/core";
import { initializeProject, initializeWorkspace, registerProject } from "@relay/project-runtime";
import { ProjectDatabase } from "@relay/storage";
import { withCliFixture } from "./helpers/cli-fixture";
import { entityValue, objectValue, stringValue } from "./helpers/responses";

const concurrentReads = [
  { name: "полное адресное чтение", argv: ["get", "PROJECT"] },
  { name: "краткое адресное чтение", argv: ["get", "PROJECT", "--summary"] },
  { name: "обзор", argv: ["overview"] },
  { name: "список задач", argv: ["task", "list"] },
  { name: "поиск", argv: ["search", "--q", "Проверка"] },
  { name: "диагностика", argv: ["doctor", "check"] },
] as const;
const workspaceSelections = [
  {
    name: "селектор перед командой",
    registration: "one",
    argv: ["--project", "one", "project", "get"],
  },
  {
    name: "селектор после команды",
    registration: "two",
    argv: ["project", "get", "--project", "two"],
  },
] as const;
const invalidRelayHomes = [
  { name: "пустой", value: "" },
  { name: "из пробельных символов", value: " \t " },
] as const;

describe("Локальный проект CLI", () => {
  test("init передаёт имя и slug в проект и возвращает его расположение", async () => {
    await withCliFixture(async (cli) => {
      const answer = await cli.success(["init", "--name", "Новый проект", "--slug", "new-project"]);

      const data = objectValue(answer.data);
      const project = {
        projectId: stringValue(data.projectId),
        databasePath: stringValue(data.databasePath),
        configPath: stringValue(data.configPath),
      };
      expect(project.configPath).toBe(join(cli.runtime.cwd, "relay.config.json"));
      expect(cli.withDatabase(project, (db) => db.get(project.projectId)?.data)).toEqual({
        name: "Новый проект",
        slug: "new-project",
      });
      expect((await cli.entity(["project", "get"])).id).toBe(project.projectId);
      const config = await cli.success(["config", "get"]);
      expect(config.data).toEqual({ version: 1, projectId: project.projectId });
      expect(config.meta).toMatchObject(project);
    });
  });

  test("без RELAY_HOME конфиг без пути выбирает базу из HOME/.relay", async () => {
    await withCliFixture(async (cli) => {
      const home = join(cli.root, "user");
      const project = initializeProject({ cwd: cli.runtime.cwd, home: join(home, ".relay") });

      const selected = await cli.entity(["project", "get"], { env: { HOME: home } });

      expect(selected.id).toBe(project.projectId);
    });
  });

  test.each(invalidRelayHomes)(
    "RELAY_HOME $name отклоняется при init без создания файлов",
    async ({ value }) => {
      await withCliFixture(async (cli) => {
        const env = { HOME: join(cli.root, "user"), RELAY_HOME: value };

        const error = await cli.error(["init", "--config", "settings/project.json"], 2, { env });

        expect(error.code).toBe("INVALID_ARGUMENT");
        expect(readdirSync(cli.runtime.cwd)).toEqual([]);
        expect(readdirSync(cli.root)).toEqual(["project"]);
      });
    },
  );

  test("относительный RELAY_HOME и явный config сохраняются при создании и выборе проекта", async () => {
    await withCliFixture(async (cli) => {
      const env = {
        HOME: join(cli.root, "user"),
        RELAY_HOME: "../local-data",
        RELAY_CONFIG: "missing.json",
      };
      const config = "settings/project.json";

      const answer = await cli.success(["init", "--config", config], { env });

      const data = objectValue(answer.data);
      const projectId = stringValue(data.projectId);
      expect(data.configPath).toBe(join(cli.runtime.cwd, config));
      expect(data.databasePath).toBe(
        join(cli.root, "local-data", "projects", projectId, "project.sqlite"),
      );
      expect((await cli.entity(["project", "get", "--config", config], { env })).id).toBe(
        projectId,
      );
      expect(readdirSync(cli.root).sort()).toEqual(["local-data", "project"]);
    });
  });

  test("из вложенного каталога требуется явный config, родительский проект не выбирается", async () => {
    await withCliFixture(async (cli) => {
      const project = cli.createProject();
      const cwd = join(cli.runtime.cwd, "nested");
      mkdirSync(cwd);

      const error = await cli.error(["project", "get"], 3, { cwd });

      expect(error.code).toBe("PROJECT_NOT_FOUND");
      const selected = await cli.entity(["project", "get", "--config", "../relay.config.json"], {
        cwd,
      });
      expect(selected.id).toBe(project.projectId);
    });
  });

  test.each(concurrentReads)(
    "$name остаётся доступен при удерживаемой блокировке писателя",
    async ({ argv }) => {
      await withCliFixture(async (cli) => {
        const project = cli.createProject();
        const writer = new Database(project.databasePath);
        try {
          writer.exec("BEGIN IMMEDIATE");

          // success проверяет нулевой код, пустой stderr и успешный JSON-конверт.
          await cli.success(argv);
        } finally {
          if (writer.inTransaction) {
            writer.exec("ROLLBACK");
          }
          writer.close();
        }
      }, "get-batch/cli-open-project");
    },
  );

  test("запись при занятом писателе возвращает STORAGE_BUSY без создания задачи", async () => {
    await withCliFixture(async (cli) => {
      const project = cli.createProject();
      const generation = cli.withDatabase(project, (db) => db.getGeneration());
      const writer = new Database(project.databasePath);
      try {
        writer.exec("BEGIN IMMEDIATE");

        const error = await cli.error(["task", "create", "--title", "Ожидает писателя"], 4);

        expect(error.code).toBe("STORAGE_BUSY");
      } finally {
        if (writer.inTransaction) {
          writer.exec("ROLLBACK");
        }
        writer.close();
      }
      expect((await cli.page(["task", "list"], entityValue)).data.items).toEqual([]);
      expect(cli.withDatabase(project, (db) => db.getGeneration())).toBe(generation);
    });
  });

  test("подмена базы между выбором и открытием не направляет запись в другой проект", async () => {
    await withCliFixture(async (cli) => {
      const project = cli.createProject();
      const revision = cli.withDatabase(
        project,
        (db) => new KnowledgeService(db).get("project").revision,
      );
      const foreignPath = join(cli.root, "foreign.sqlite");
      const foreign = ProjectDatabase.create(foreignPath, {
        id: crypto.randomUUID(),
        name: "Чужой",
        slug: "foreign",
      });
      let foreignId: string;
      try {
        foreignId = foreign.projectId;
      } finally {
        foreign.close();
      }
      const open = ProjectDatabase.open;
      const close = spyOn(ProjectDatabase.prototype, "close");
      let opens = 0;
      // Перехватывается только путь этой fixture, после выбора проекта и до открытия сценария.
      const interception = spyOn(ProjectDatabase, "open").mockImplementation((path) => {
        if (path === project.databasePath && ++opens === 1) {
          copyFileSync(foreignPath, path);
        }
        return open(path);
      });
      try {
        const error = await cli.error(
          ["project", "update", "--name", "Не сохранять", "--if-revision", String(revision)],
          4,
        );

        expect(error.code).toBe("PROJECT_ID_MISMATCH");
        expect(error.details).toMatchObject({ expected: project.projectId, actual: foreignId });
        expect(opens).toBe(1);
        expect(close).toHaveBeenCalledTimes(1);
      } finally {
        interception.mockRestore();
        close.mockRestore();
      }
      expect(cli.withDatabase(project, (db) => db.get("PROJECT")?.data.name)).toBe("Чужой");
      const stored = cli.withDatabase(project, (db) => ({
        project: db.get("PROJECT"),
        generation: db.getGeneration(),
      }));
      const original = cli.withDatabase({ ...project, databasePath: foreignPath }, (db) => ({
        project: db.get("PROJECT"),
        generation: db.getGeneration(),
      }));
      expect(stored).toEqual(original);
    }, "get-batch/cli-open-project");
  });
});

describe("Выбор и регистрация проектов workspace", () => {
  test("workspace с несколькими проектами без селектора возвращает PROJECT_REQUIRED", async () => {
    await withCliFixture(async (cli) => {
      const first = cli.createProject();
      const second = cli.createProject(join(cli.root, "other"));
      const cwd = join(cli.root, "workspace");
      mkdirSync(cwd);
      initializeWorkspace({ cwd });
      const options = { cwd, home: stringValue(cli.runtime.env.RELAY_HOME) };
      registerProject(options, "one", dirname(first.configPath));
      registerProject(options, "two", dirname(second.configPath));

      const error = await cli.error(["project", "get"], 2, { cwd });

      expect(error.code).toBe("PROJECT_REQUIRED");
    });
  });

  test.each(workspaceSelections)(
    "$name выбирает указанную регистрацию",
    async ({ registration, argv }) => {
      await withCliFixture(async (cli) => {
        const projects = {
          one: cli.createProject(),
          two: cli.createProject(join(cli.root, "other")),
        };
        const cwd = join(cli.root, "workspace");
        mkdirSync(cwd);
        initializeWorkspace({ cwd });
        const options = { cwd, home: stringValue(cli.runtime.env.RELAY_HOME) };
        registerProject(options, "one", dirname(projects.one.configPath));
        registerProject(options, "two", dirname(projects.two.configPath));

        const selected = await cli.entity(argv, { cwd });

        expect(selected.id).toBe(projects[registration].projectId);
      });
    },
  );

  test("инициализация workspace создаёт пустой реестр проектов", async () => {
    await withCliFixture(async (cli) => {
      const cwd = join(cli.root, "workspace");
      mkdirSync(cwd);

      await cli.success(["workspace", "project", "init"], { cwd });

      const registered = await cli.page(["workspace", "project", "list"], objectValue, { cwd });
      expect(registered.data.items).toEqual([]);
      expect(registered.meta.page.total).toBe(0);
    });
  });

  test("добавление регистрации публикует её имя и путь к каталогу проекта", async () => {
    await withCliFixture(async (cli) => {
      const project = cli.createProject();
      const cwd = join(cli.root, "workspace");
      mkdirSync(cwd);
      initializeWorkspace({ cwd });

      await cli.success(["workspace", "project", "add", "one", dirname(project.configPath)], {
        cwd,
      });

      const registered = await cli.page(["workspace", "project", "list"], objectValue, { cwd });
      expect(registered.meta.page.total).toBe(1);
      expect(registered.data.items[0]).toEqual({
        name: "one",
        path: cli.runtime.cwd,
      });
    });
  });

  test("удаление регистрации очищает реестр и сохраняет локальную базу проекта", async () => {
    await withCliFixture(async (cli) => {
      const project = cli.createProject();
      const cwd = join(cli.root, "workspace");
      mkdirSync(cwd);
      initializeWorkspace({ cwd });
      registerProject(
        { cwd, home: stringValue(cli.runtime.env.RELAY_HOME) },
        "one",
        dirname(project.configPath),
      );

      await cli.success(["workspace", "project", "remove", "one"], { cwd });

      expect(
        (await cli.page(["workspace", "project", "list"], objectValue, { cwd })).data.items,
      ).toEqual([]);
      expect((await cli.entity(["project", "get"])).id).toBe(project.projectId);
    });
  });
});
