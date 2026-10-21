import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  readdirSync,
  statSync,
  symlinkSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";
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

describe("Локальные регистрации workspace", () => {
  let fixture: RuntimeFixture;

  beforeEach(() => {
    fixture = new RuntimeFixture();
  });

  afterEach(async () => {
    await fixture.dispose();
  });

  test("новый workspace содержит пустой список регистраций", () => {
    const { cwd, home } = fixture;

    const workspace = initializeWorkspace({ cwd, home });

    expect(workspace.configPath).toBe(join(cwd, "relay.workspace.json"));
    expect(listProjects({ cwd, home })).toEqual([]);
    expect(existsSync(home)).toBe(false);
  });

  test("регистрация каталогов сохраняет абсолютные пути в порядке добавления", () => {
    const { cwd, home, root } = fixture;
    initializeWorkspace({ cwd, home });
    initializeProject({ cwd: join(cwd, "alpha"), home });
    const beta = initializeProject({ cwd: join(root, "beta"), home });

    registerProject({ cwd, home }, "alpha", "alpha");
    registerProject({ cwd, home }, "beta", dirname(beta.configPath));

    expect(listProjects({ cwd, home })).toEqual([
      { name: "alpha", path: join(cwd, "alpha") },
      { name: "beta", path: join(root, "beta") },
    ]);
  });

  test("публикация регистрации сохраняет целый прежний JSON для уже открытого читателя", () => {
    const { cwd, home, root } = fixture;
    const workspace = initializeWorkspace({ cwd, home });
    const project = initializeProject({ cwd: join(root, "alpha"), home });
    const original = readFileSync(workspace.configPath, "utf8");
    // Читатель уже открыл файл, но ещё не прочитал его: запись поверх этого inode
    // нарушит снимок независимо от скорости записи и планирования другого процесса.
    const reader = openSync(workspace.configPath, "r");
    try {
      registerProject({ cwd, home }, "alpha", dirname(project.configPath));

      expect(readFileSync(reader, "utf8")).toBe(original);
      expect(JSON.parse(readFileSync(workspace.configPath, "utf8"))).toEqual({
        version: 1,
        projects: [{ name: "alpha", path: join(root, "alpha") }],
      });
    } finally {
      closeSync(reader);
    }
  });

  test("отказ публикации регистрации сохраняет JSON, убирает временный файл и освобождает mutex", () => {
    const { cwd, home, root } = fixture;
    const workspace = initializeWorkspace({ cwd, home });
    const project = initializeProject({ cwd: join(root, "alpha"), home });
    const original = readFileSync(workspace.configPath, "utf8");
    const rename = fs.renameSync;
    const publisher = spyOn(fs, "renameSync").mockImplementation((source, destination) => {
      // Временный JSON уже записан; отказ возникает на границе его публикации,
      // а не вместо проверяемого механизма записи или получения mutex.
      if (destination === workspace.configPath) {
        throw Object.assign(new Error("Отказ публикации workspace"), { code: "EIO" });
      }
      rename(source, destination);
    });
    try {
      const code = runtimeErrorCode(() =>
        registerProject({ cwd, home }, "alpha", dirname(project.configPath)),
      );

      expect(code).toBe("IO_ERROR");
      expect(readFileSync(workspace.configPath, "utf8")).toBe(original);
      expect(readdirSync(cwd).sort()).toEqual([
        "relay.workspace.json",
        "relay.workspace.json.lock.sqlite",
      ]);
    } finally {
      publisher.mockRestore();
    }
    // После снятия отказа та же операция проходит без ручного освобождения замка.
    registerProject({ cwd, home }, "alpha", dirname(project.configPath));
    expect(listProjects({ cwd, home })).toEqual([{ name: "alpha", path: join(root, "alpha") }]);
  });

  test("workspace требует явного выбора имени проекта", () => {
    const { cwd, home } = fixture;
    initializeWorkspace({ cwd, home });

    const code = runtimeErrorCode(() => resolveProject({ cwd, home }));

    expect(code).toBe("PROJECT_REQUIRED");
  });

  test("имя регистрации выбирает соответствующий проект workspace", () => {
    const { cwd, home } = fixture;
    initializeWorkspace({ cwd, home });
    const project = initializeProject({ cwd: join(cwd, "alpha"), home });
    registerProject({ cwd, home }, "alpha", dirname(project.configPath));

    const selected = resolveProject({ cwd, home, project: "alpha" });

    expect(selected).toEqual(project);
  });

  test("выбор регистрации и список из каталога проекта не используют родительский workspace", () => {
    const { cwd, home } = fixture;
    initializeWorkspace({ cwd, home });
    initializeProject({ cwd: join(cwd, "alpha"), home });
    const beta = initializeProject({ cwd: join(cwd, "beta"), home });
    registerProject({ cwd, home }, "beta", dirname(beta.configPath));

    const code = runtimeErrorCode(() =>
      resolveProject({ cwd: join(cwd, "alpha"), home, project: "beta" }),
    );

    expect(code).toBe("PROJECT_NOT_FOUND");
    expect(runtimeErrorCode(() => listProjects({ cwd: join(cwd, "alpha"), home }))).toBe(
      "WORKSPACE_NOT_FOUND",
    );
    expect(resolveProject({ cwd, home, project: "beta" })).toEqual(beta);
  });

  test("явный workspace позволяет выбрать регистрацию из внешнего cwd", () => {
    const { cwd, home, root } = fixture;
    const workspace = initializeWorkspace({ cwd, home });
    const project = initializeProject({ cwd: join(cwd, "beta"), home });
    registerProject({ cwd, home }, "beta", dirname(project.configPath));

    const selected = resolveProject({
      cwd: root,
      home,
      config: workspace.configPath,
      project: "beta",
    });

    expect(selected).toEqual(project);
  });

  test("отсутствующее имя регистрации возвращает PROJECT_NOT_FOUND", () => {
    const { cwd, home } = fixture;
    initializeWorkspace({ cwd, home });

    const code = runtimeErrorCode(() => resolveProject({ cwd, home, project: "absent" }));

    expect(code).toBe("PROJECT_NOT_FOUND");
  });

  test("повтор регистрации через symlink является no-op для того же физического каталога", () => {
    const { cwd, home, root } = fixture;
    const workspace = initializeWorkspace({ cwd, home });
    const project = initializeProject({ cwd: join(root, "alpha"), home });
    registerProject({ cwd, home }, "alpha", dirname(project.configPath));
    const original = readFileSync(workspace.configPath, "utf8");
    const inode = statSync(workspace.configPath).ino;
    const alias = join(root, "project-link");
    symlinkSync(dirname(project.configPath), alias);

    registerProject({ cwd, home }, "alpha", alias);

    expect(listProjects({ cwd, home })).toEqual([{ name: "alpha", path: join(root, "alpha") }]);
    expect(readFileSync(workspace.configPath, "utf8")).toBe(original);
    expect(statSync(workspace.configPath).ino).toBe(inode);
  });

  test("занятое имя с другим проектом отклоняется без изменения реестра", () => {
    const { cwd, home, root } = fixture;
    const workspace = initializeWorkspace({ cwd, home });
    const alpha = initializeProject({ cwd: join(root, "alpha"), home });
    const beta = initializeProject({ cwd: join(root, "beta"), home });
    registerProject({ cwd, home }, "alpha", dirname(alpha.configPath));
    const original = readFileSync(workspace.configPath, "utf8");

    const code = runtimeErrorCode(() =>
      registerProject({ cwd, home }, "alpha", dirname(beta.configPath)),
    );

    expect(code).toBe("PROJECT_EXISTS");
    expect(readFileSync(workspace.configPath, "utf8")).toBe(original);
    expect(listProjects({ cwd, home })).toEqual([{ name: "alpha", path: join(root, "alpha") }]);
  });

  test("удаление регистрации сохраняет конфиг и данные доступного проекта", () => {
    const { cwd, home, root } = fixture;
    initializeWorkspace({ cwd, home });
    const project = initializeProject({ cwd: join(root, "alpha"), home, name: "Сохранённый" });
    registerProject({ cwd, home }, "alpha", dirname(project.configPath));
    const original = readFileSync(project.configPath, "utf8");

    const removed = unregisterProject({ cwd, home }, "alpha");

    expect(removed).toBe(true);
    expect(listProjects({ cwd, home })).toEqual([]);
    expect(readFileSync(project.configPath, "utf8")).toBe(original);
    expect(resolveProject({ cwd: root, home, config: project.configPath })).toEqual(project);
    withProjectDatabase(project, (database) => {
      expect(database.get("PROJECT")?.data.name).toBe("Сохранённый");
    });
  });

  test("удаление отсутствующей регистрации возвращает false и не меняет JSON", () => {
    const { cwd, home } = fixture;
    const workspace = initializeWorkspace({ cwd, home });
    const original = readFileSync(workspace.configPath, "utf8");
    const inode = statSync(workspace.configPath).ino;

    const removed = unregisterProject({ cwd, home }, "absent");

    expect(removed).toBe(false);
    expect(readFileSync(workspace.configPath, "utf8")).toBe(original);
    expect(statSync(workspace.configPath).ino).toBe(inode);
  });

  test("повтор удаления регистрации возвращает false", () => {
    const { cwd, home, root } = fixture;
    initializeWorkspace({ cwd, home });
    const project = initializeProject({ cwd: join(root, "alpha"), home });
    registerProject({ cwd, home }, "alpha", dirname(project.configPath));
    unregisterProject({ cwd, home }, "alpha");

    const removed = unregisterProject({ cwd, home }, "alpha");

    expect(removed).toBe(false);
    expect(listProjects({ cwd, home })).toEqual([]);
  });

  test("удалённый проект можно зарегистрировать повторно с прежними данными", () => {
    const { cwd, home, root } = fixture;
    initializeWorkspace({ cwd, home });
    const project = initializeProject({ cwd: join(root, "alpha"), home });
    registerProject({ cwd, home }, "alpha", dirname(project.configPath));
    unregisterProject({ cwd, home }, "alpha");

    registerProject({ cwd, home }, "alpha", dirname(project.configPath));

    expect(resolveProject({ cwd, home, project: "alpha" })).toEqual(project);
  });

  test("недоступную регистрацию можно перечислить и удалить без восстановления проекта", () => {
    const { cwd, home, root } = fixture;
    const workspace = initializeWorkspace({ cwd, home });
    const missing = join(root, "missing");
    writeConfig(workspace.configPath, {
      version: 1,
      projects: [{ name: "broken", path: relative(cwd, missing) }],
    });
    expect(listProjects({ cwd, home })).toEqual([{ name: "broken", path: missing }]);
    expect(runtimeErrorCode(() => resolveProject({ cwd, home, project: "broken" }))).toBe(
      "CONFIG_NOT_FOUND",
    );

    const removed = unregisterProject({ cwd, home }, "broken");

    expect(removed).toBe(true);
    expect(listProjects({ cwd, home })).toEqual([]);
    expect(existsSync(join(root, "missing"))).toBe(false);
  });

  test("повтор init workspace по явному пути не изменяет файл", () => {
    const { cwd, home } = fixture;
    const options = { cwd, home, config: "custom/workspace.json" };
    const workspace = initializeWorkspace(options);
    const original = readFileSync(workspace.configPath, "utf8");

    const code = runtimeErrorCode(() => initializeWorkspace(options));

    expect(code).toBe("CONFIG_EXISTS");
    expect(readFileSync(workspace.configPath, "utf8")).toBe(original);
    expect(readdirSync(dirname(workspace.configPath))).toEqual(["workspace.json"]);
    expect(existsSync(home)).toBe(false);
  });

  test("несуществующий проект не добавляется в реестр", () => {
    const { cwd, home } = fixture;
    const workspace = initializeWorkspace({ cwd, home });
    const original = readFileSync(workspace.configPath, "utf8");

    const code = runtimeErrorCode(() => registerProject({ cwd, home }, "missing", "missing"));

    expect(code).toBe("CONFIG_NOT_FOUND");
    expect(readFileSync(workspace.configPath, "utf8")).toBe(original);
    expect(listProjects({ cwd, home })).toEqual([]);
    expect(readdirSync(cwd)).toEqual(["relay.workspace.json"]);
    expect(existsSync(home)).toBe(false);
  });

  test("валидный нестандартный файл конфига не принимается вместо каталога проекта", () => {
    const { cwd, home, root } = fixture;
    const workspace = initializeWorkspace({ cwd, home });
    const directory = join(root, "alpha");
    const project = initializeProject({ cwd: directory, home, config: "custom.json" });
    const original = readFileSync(workspace.configPath, "utf8");

    const code = runtimeErrorCode(() =>
      registerProject({ cwd, home }, "alpha", project.configPath),
    );

    expect(code).toBe("INVALID_CONFIG");
    expect(readFileSync(workspace.configPath, "utf8")).toBe(original);
    expect(listProjects({ cwd, home })).toEqual([]);
    expect(readdirSync(cwd)).toEqual(["relay.workspace.json"]);
    expect(readdirSync(directory)).toEqual(["custom.json"]);
    expect(resolveProject({ cwd: directory, home, config: "custom.json" })).toEqual(project);
  });

  test("пустое имя регистрации отклоняется без изменения workspace", () => {
    const { cwd, home } = fixture;
    const workspace = initializeWorkspace({ cwd, home });
    const original = readFileSync(workspace.configPath, "utf8");

    const code = runtimeErrorCode(() => registerProject({ cwd, home }, " ", "missing"));

    expect(code).toBe("INVALID_ARGUMENT");
    expect(readFileSync(workspace.configPath, "utf8")).toBe(original);
    expect(listProjects({ cwd, home })).toEqual([]);
    expect(readdirSync(cwd)).toEqual(["relay.workspace.json"]);
    expect(existsSync(home)).toBe(false);
  });

  test("каталог без своего relay.config.json не использует конфиг родителя при регистрации", () => {
    const { cwd, home, root } = fixture;
    const workspace = initializeWorkspace({ cwd, home });
    const parent = initializeProject({ cwd: join(root, "parent"), home });
    const nested = join(root, "parent", "nested");
    fs.mkdirSync(nested);
    const original = readFileSync(workspace.configPath, "utf8");

    const code = runtimeErrorCode(() => registerProject({ cwd, home }, "nested", nested));

    expect(code).toBe("CONFIG_NOT_FOUND");
    expect(readFileSync(workspace.configPath, "utf8")).toBe(original);
    expect(readdirSync(nested)).toEqual([]);
    expect(resolveProject({ cwd: join(root, "parent"), home })).toEqual(parent);
  });
});
