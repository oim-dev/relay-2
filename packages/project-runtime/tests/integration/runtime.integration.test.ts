import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, symlinkSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { ProjectDatabase } from "@relay/storage";
import {
  initializeProject,
  initializeWorkspace,
  listProjects,
  registerProject,
  resolveProject,
  unregisterProject,
} from "@relay/project-runtime";
import {
  RuntimeFixture,
  runtimeErrorCode,
  withProjectDatabase,
  writeConfig,
} from "./helpers/runtime-fixture";

describe("Инициализация и выбор локального проекта", () => {
  let fixture: RuntimeFixture;

  beforeEach(() => {
    fixture = new RuntimeFixture();
  });

  afterEach(async () => {
    await fixture.dispose();
  });

  test("init публикует конфиг со ссылкой на внешнюю базу и сохраняет метаданные проекта", () => {
    const { cwd, home } = fixture;

    const project = initializeProject({ cwd, home, name: "Первый проект", slug: "first" });

    expect(project.databasePath).toBe(join(home, "projects", project.projectId, "project.sqlite"));
    expect(project.configPath).toBe(join(cwd, "relay.config.json"));
    expect(JSON.parse(readFileSync(project.configPath, "utf8"))).toEqual({
      version: 1,
      projectId: project.projectId,
      databasePath: project.databasePath,
    });
    expect(readdirSync(cwd)).toEqual(["relay.config.json"]);
    withProjectDatabase(project, (database) => {
      expect(database.get("PROJECT")?.data).toEqual({ name: "Первый проект", slug: "first" });
    });
  });

  test("запись в первый проект сохраняется после открытия и не попадает в базу второго", () => {
    const { cwd, home, root } = fixture;
    const first = initializeProject({ cwd, home, name: "Первый проект" });
    const second = initializeProject({ cwd: join(root, "second"), home, name: "Второй проект" });

    withProjectDatabase(first, (database) => {
      const now = new Date().toISOString();
      database.insert({
        id: crypto.randomUUID(),
        kind: "document",
        key: "DOC-1",
        revision: 1,
        createdAt: now,
        updatedAt: now,
        createdBy: "test",
        updatedBy: "test",
        data: { title: "Только в первом" },
      });
    });

    expect(second.projectId).not.toBe(first.projectId);
    withProjectDatabase(second, (database) => {
      expect(database.get("PROJECT")?.data.name).toBe("Второй проект");
      expect(database.get("DOC-1")).toBeUndefined();
    });
    withProjectDatabase(first, (database) => {
      expect(database.get("DOC-1")?.data.title).toBe("Только в первом");
    });
  });

  test("вложенный cwd без своего конфига не выбирает проект родителя", () => {
    const { cwd, home } = fixture;
    const project = initializeProject({ cwd, home });
    const nested = join(cwd, "src", "deep");
    mkdirSync(nested, { recursive: true });

    const code = runtimeErrorCode(() => resolveProject({ cwd: nested, home }));

    expect(code).toBe("PROJECT_NOT_FOUND");
    expect(readdirSync(nested)).toEqual([]);
    expect(resolveProject({ cwd, home })).toEqual(project);
  });

  test("явный относительный config имеет приоритет над проектом cwd", () => {
    const { cwd, home, root } = fixture;
    initializeProject({ cwd, home });
    const selectedProject = initializeProject({ cwd: join(root, "second"), home });

    const selected = resolveProject({
      cwd,
      home,
      config: relative(cwd, selectedProject.configPath),
    });

    expect(selected).toEqual(selectedProject);
  });

  test("отсутствующий явный config не подменяется родительским проектом", () => {
    const { cwd, home } = fixture;
    initializeProject({ cwd, home });
    const nested = join(cwd, "src", "deep");
    mkdirSync(nested, { recursive: true });

    const code = runtimeErrorCode(() =>
      resolveProject({ cwd: nested, home, config: "missing.json" }),
    );

    expect(code).toBe("CONFIG_NOT_FOUND");
    expect(existsSync(join(nested, "missing.json"))).toBe(false);
  });

  test("проектный config с --project отклоняется до открытия недоступной базы", () => {
    const { cwd, home } = fixture;
    initializeWorkspace({ cwd, home });
    const alpha = initializeProject({ cwd: join(cwd, "alpha"), home });
    const beta = initializeProject({ cwd: join(cwd, "beta"), home });
    registerProject({ cwd, home }, "beta", dirname(beta.configPath));
    renameSync(alpha.databasePath, `${alpha.databasePath}.saved`);
    const open = spyOn(ProjectDatabase, "open");
    try {
      // Недоступная alpha не должна открываться или подменяться регистрацией beta из родителя.
      const code = runtimeErrorCode(() =>
        resolveProject({ cwd, home, config: alpha.configPath, project: "beta" }),
      );

      expect(code).toBe("WORKSPACE_REQUIRED");
      expect(open).not.toHaveBeenCalled();
      expect(existsSync(alpha.databasePath)).toBe(false);
    } finally {
      open.mockRestore();
    }
  });

  test("повтор init в каталоге проекта не затирает конфиг и не создаёт новую базу", () => {
    const { cwd, home } = fixture;
    const project = initializeProject({ cwd, home });
    const original = readFileSync(project.configPath, "utf8");

    const code = runtimeErrorCode(() => initializeProject({ cwd, home, name: "Замена" }));

    expect(code).toBe("CONFIG_EXISTS");
    expect(readFileSync(project.configPath, "utf8")).toBe(original);
    expect(readdirSync(join(home, "projects"))).toEqual([project.projectId]);
    expect(resolveProject({ cwd, home })).toEqual(project);
  });

  test("init проекта в каталоге workspace отклоняется без создания конфига и базы", () => {
    const { cwd, home } = fixture;
    const workspace = initializeWorkspace({ cwd, home });
    const original = readFileSync(workspace.configPath, "utf8");

    const code = runtimeErrorCode(() => initializeProject({ cwd, home }));

    expect(code).toBe("CONFIG_EXISTS");
    expect(readFileSync(workspace.configPath, "utf8")).toBe(original);
    expect(readdirSync(cwd)).toEqual(["relay.workspace.json"]);
    expect(existsSync(home)).toBe(false);
  });

  test("init workspace в каталоге проекта отклоняется с сохранением конфига и базы", () => {
    const { cwd, home } = fixture;
    const project = initializeProject({ cwd, home });
    const original = readFileSync(project.configPath, "utf8");

    const code = runtimeErrorCode(() => initializeWorkspace({ cwd, home }));

    expect(code).toBe("CONFIG_EXISTS");
    expect(readFileSync(project.configPath, "utf8")).toBe(original);
    expect(readdirSync(cwd)).toEqual(["relay.config.json"]);
    expect(readdirSync(join(home, "projects"))).toEqual([project.projectId]);
    expect(resolveProject({ cwd, home })).toEqual(project);
  });

  test("init во вложенном каталоге создаёт независимый проект и сохраняет родительский", () => {
    const { cwd, home } = fixture;
    const project = initializeProject({ cwd, home });
    const original = readFileSync(project.configPath, "utf8");
    const nested = join(cwd, "src", "deep");
    mkdirSync(nested, { recursive: true });

    const child = initializeProject({ cwd: nested, home });

    expect(child.projectId).not.toBe(project.projectId);
    expect(child.configPath).toBe(join(nested, "relay.config.json"));
    expect(readFileSync(project.configPath, "utf8")).toBe(original);
    expect(readdirSync(join(home, "projects")).sort()).toEqual(
      [project.projectId, child.projectId].sort(),
    );
    expect(resolveProject({ cwd: nested, home })).toEqual(child);
    expect(resolveProject({ cwd, home })).toEqual(project);
  });

  test("старый .relay/config.json доступен только через явный config", () => {
    const { cwd, home } = fixture;
    const project = initializeProject({ cwd, home, config: ".relay/config.json" });

    const code = runtimeErrorCode(() => resolveProject({ cwd, home }));

    expect(code).toBe("PROJECT_NOT_FOUND");
    expect(existsSync(join(cwd, "relay.config.json"))).toBe(false);
    expect(resolveProject({ cwd, home, config: project.configPath })).toEqual(project);
  });

  test("init создаёт отсутствующий вложенный cwd", () => {
    const { cwd, home } = fixture;
    const nested = join(cwd, "new", "deep");

    const project = initializeProject({ cwd: nested, home });

    expect(resolveProject({ cwd: nested, home })).toEqual(project);
  });

  test("init публикует проект по явному относительному пути конфига", () => {
    const { cwd, home } = fixture;

    const project = initializeProject({ cwd, home, config: "settings/local.json" });

    expect(project.configPath).toBe(join(cwd, "settings", "local.json"));
    expect(resolveProject({ cwd, home, config: "settings/local.json" })).toEqual(project);
  });

  test("повтор init с явным config сохраняет первоначальный проект", () => {
    const { cwd, home } = fixture;
    const options = { cwd, home, config: "settings/local.json" };
    const project = initializeProject(options);
    const original = readFileSync(project.configPath, "utf8");

    const code = runtimeErrorCode(() => initializeProject(options));

    expect(code).toBe("CONFIG_EXISTS");
    expect(readFileSync(project.configPath, "utf8")).toBe(original);
    expect(readdirSync(join(home, "projects"))).toEqual([project.projectId]);
  });

  test("поиск отсутствующего проекта не создаёт конфиг или домашний каталог", () => {
    const { cwd, home } = fixture;

    const code = runtimeErrorCode(() => resolveProject({ cwd, home }));

    expect(code).toBe("PROJECT_NOT_FOUND");
    expect(readdirSync(cwd)).toEqual([]);
    expect(existsSync(home)).toBe(false);
  });

  test("чтение отсутствующего workspace не создаёт файлы", () => {
    const { cwd, home } = fixture;

    const code = runtimeErrorCode(() => listProjects({ cwd, home }));

    expect(code).toBe("WORKSPACE_NOT_FOUND");
    expect(readdirSync(cwd)).toEqual([]);
    expect(existsSync(home)).toBe(false);
  });

  test("удаление регистрации без workspace не создаёт файлы", () => {
    const { cwd, home } = fixture;

    const code = runtimeErrorCode(() => unregisterProject({ cwd, home }, "absent"));

    expect(code).toBe("WORKSPACE_NOT_FOUND");
    expect(readdirSync(cwd)).toEqual([]);
    expect(existsSync(home)).toBe(false);
  });

  test("ссылка на базу другого проекта отклоняется без изменения обеих баз", () => {
    const { cwd, home, root } = fixture;
    const project = initializeProject({ cwd, home, name: "Первый" });
    const second = initializeProject({ cwd: join(root, "second"), home, name: "Второй" });
    // Намеренно нарушаем связь постоянного ID с базой, сохраняя валидную форму JSON.
    writeConfig(project.configPath, {
      version: 1,
      projectId: project.projectId,
      databasePath: second.databasePath,
    });

    const code = runtimeErrorCode(() => resolveProject({ cwd, home }));

    expect(code).toBe("PROJECT_ID_MISMATCH");
    withProjectDatabase(project, (database) => {
      expect(database.get("PROJECT")?.data.name).toBe("Первый");
    });
    withProjectDatabase(second, (database) => {
      expect(database.get("PROJECT")?.data.name).toBe("Второй");
    });
    expect(resolveProject({ cwd: join(root, "second"), home })).toEqual(second);
  });

  test("потерянная база не создаётся заново при выборе проекта", () => {
    const { cwd, home } = fixture;
    const project = initializeProject({ cwd, home });
    const moved = `${project.databasePath}.saved`;
    renameSync(project.databasePath, moved);

    const code = runtimeErrorCode(() => resolveProject({ cwd, home }));

    expect(code).toBe("DATABASE_NOT_FOUND");
    expect(existsSync(project.databasePath)).toBe(false);
    expect(existsSync(moved)).toBe(true);
  });

  test("относительный путь базы определяется физическим каталогом конфига через symlink", () => {
    const { cwd, home, root } = fixture;
    const project = initializeProject({ cwd, home });
    writeConfig(project.configPath, {
      version: 1,
      projectId: project.projectId,
      databasePath: relative(dirname(project.configPath), project.databasePath),
    });
    const link = join(root, "project.json");
    symlinkSync(project.configPath, link);

    const selected = resolveProject({ cwd: root, home, config: link });

    expect(selected).toEqual({ ...project, configPath: link });
  });
});
