import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import {
  initializeProject,
  initializeWorkspace,
  listProjects,
  resolveProject,
} from "@relay/project-runtime";
import { RuntimeFixture, runtimeErrorCode, writeConfig } from "./helpers/runtime-fixture";

const invalidConfigs = [
  { name: "не JSON", contents: "{" },
  { name: "null", contents: "null" },
  { name: "массив", contents: "[]" },
  {
    name: "будущая версия",
    contents: JSON.stringify({ version: 2, projectId: "id", databasePath: "/missing" }),
  },
  {
    name: "проект без ID",
    contents: JSON.stringify({ version: 1, databasePath: "/missing" }),
  },
  {
    name: "пустой путь",
    contents: JSON.stringify({ version: 1, projectId: "id", databasePath: "" }),
  },
  {
    name: "null вместо явного пути",
    contents: JSON.stringify({ version: 1, projectId: "id", databasePath: null }),
  },
  {
    name: "нестроковый путь",
    contents: JSON.stringify({ version: 1, projectId: "id", databasePath: 42 }),
  },
  {
    name: "ID текущего каталога без явного пути",
    contents: JSON.stringify({ version: 1, projectId: "." }),
  },
  {
    name: "ID родительского каталога без явного пути",
    contents: JSON.stringify({ version: 1, projectId: ".." }),
  },
  {
    name: "выход из каталога проектов через ID",
    contents: JSON.stringify({ version: 1, projectId: "../outside" }),
  },
  {
    name: "обратный разделитель пути в ID",
    contents: JSON.stringify({ version: 1, projectId: "nested\\project" }),
  },
  {
    name: "нестроковый ID",
    contents: JSON.stringify({ version: 1, projectId: 42, databasePath: "/missing" }),
  },
  {
    name: "смешанные конфиги",
    contents: JSON.stringify({
      version: 1,
      projectId: "id",
      databasePath: "/missing",
      projects: [],
    }),
  },
  {
    name: "регистрация со старым полем configPath",
    contents: JSON.stringify({ version: 1, projects: [{ name: "old", configPath: "/old" }] }),
  },
  {
    name: "регистрация с конфликтующими path и configPath",
    contents: JSON.stringify({
      version: 1,
      projects: [{ name: "mixed", path: "/current", configPath: "/old/config.json" }],
    }),
  },
  {
    name: "регистрация с пустым путём каталога",
    contents: JSON.stringify({ version: 1, projects: [{ name: "empty", path: " " }] }),
  },
  {
    name: "регистрация с нестроковым путём каталога",
    contents: JSON.stringify({ version: 1, projects: [{ name: "invalid", path: 42 }] }),
  },
] as const;

describe("Диагностика локальной конфигурации", () => {
  let fixture: RuntimeFixture;

  beforeEach(() => {
    fixture = new RuntimeFixture();
  });

  afterEach(async () => {
    await fixture.dispose();
  });

  test.each(invalidConfigs)(
    "повреждённый конфиг сохраняется без побочных записей: $name",
    ({ contents }) => {
      const { cwd, home } = fixture;
      const path = join(cwd, "relay.config.json");
      // Намеренно сохраняем некорректный JSON или неподдерживаемую схему.
      writeFileSync(path, contents);

      const readCode = runtimeErrorCode(() => resolveProject({ cwd, home }));
      const initializationCode = runtimeErrorCode(() => initializeProject({ cwd, home }));

      expect(readCode).toBe("INVALID_CONFIG");
      expect(initializationCode).toBe("CONFIG_EXISTS");
      expect(readFileSync(path, "utf8")).toBe(contents);
      expect(existsSync(home)).toBe(false);
    },
  );

  test("повреждённый конфиг в cwd отклоняется при наличии проекта в родителе", () => {
    const { cwd, home } = fixture;
    initializeProject({ cwd, home });
    const nested = join(cwd, "nested");
    writeConfig(join(nested, "relay.config.json"), {});

    const code = runtimeErrorCode(() => resolveProject({ cwd: nested, home }));

    expect(code).toBe("INVALID_CONFIG");
  });

  test("каталог вместо конфига отклоняется при чтении и сохраняется при init", () => {
    const { cwd, home } = fixture;
    const path = join(cwd, "relay.config.json");
    mkdirSync(path, { recursive: true });

    const readCode = runtimeErrorCode(() => resolveProject({ cwd, home }));
    const initializationCode = runtimeErrorCode(() => initializeProject({ cwd, home }));

    expect(readCode).toBe("INVALID_CONFIG");
    expect(initializationCode).toBe("CONFIG_EXISTS");
    expect(lstatSync(path).isDirectory()).toBe(true);
    expect(existsSync(home)).toBe(false);
  });

  test("битая символьная ссылка не перезаписывается при init", () => {
    const { cwd, home, root } = fixture;
    const path = join(cwd, "relay.config.json");
    const absent = join(root, "absent.json");
    symlinkSync(absent, path);

    const readCode = runtimeErrorCode(() => resolveProject({ cwd, home }));
    const initializationCode = runtimeErrorCode(() => initializeProject({ cwd, home }));

    expect(readCode).toBe("CONFIG_NOT_FOUND");
    expect(initializationCode).toBe("CONFIG_EXISTS");
    expect(lstatSync(path).isSymbolicLink()).toBe(true);
    expect(readlinkSync(path)).toBe(absent);
    expect(existsSync(home)).toBe(false);
  });

  test("повторяющиеся имена регистраций отклоняются как повреждённый workspace", () => {
    const { cwd, home } = fixture;
    const workspace = initializeWorkspace({ cwd, home });
    writeConfig(workspace.configPath, {
      version: 1,
      projects: [
        { name: "same", path: "a" },
        { name: "same", path: "b" },
      ],
    });

    const code = runtimeErrorCode(() => listProjects({ cwd, home }));

    expect(code).toBe("INVALID_CONFIG");
  });

  test("ссылка регистрации на workspace вместо проекта отклоняется", () => {
    const { cwd, home } = fixture;
    const workspace = initializeWorkspace({ cwd, home });
    writeConfig(workspace.configPath, {
      version: 1,
      projects: [{ name: "loop", path: "." }],
    });
    symlinkSync(workspace.configPath, join(cwd, "relay.config.json"));

    const code = runtimeErrorCode(() => resolveProject({ cwd, home, project: "loop" }));

    expect(code).toBe("INVALID_CONFIG");
  });

  test("проектный config не подходит для чтения списка регистраций", () => {
    const { cwd, home } = fixture;
    const project = initializeProject({ cwd, home });

    const code = runtimeErrorCode(() => listProjects({ cwd, home, config: project.configPath }));

    expect(code).toBe("WORKSPACE_REQUIRED");
  });

  test("относительный каталог проекта разрешается от физического workspace через symlink", () => {
    const { cwd, home, root } = fixture;
    const workspace = initializeWorkspace({ cwd, home });
    const project = initializeProject({ cwd: join(cwd, "projects", "alpha"), home });
    writeConfig(workspace.configPath, {
      version: 1,
      projects: [{ name: "alpha", path: "projects/alpha" }],
    });
    const alias = join(root, "workspace-link.json");
    symlinkSync(workspace.configPath, alias);

    const selected = resolveProject({ cwd: root, home, config: alias, project: "alpha" });

    expect(selected).toEqual(project);
    expect(listProjects({ cwd: root, config: alias })).toEqual([
      { name: "alpha", path: join(cwd, "projects", "alpha") },
    ]);
  });

  test("workspace читает актуальные ID и путь базы из проектного конфига при каждом выборе", () => {
    const { cwd, home, root } = fixture;
    const workspace = initializeWorkspace({ cwd, home });
    const first = initializeProject({ cwd: join(root, "first"), home });
    const second = initializeProject({ cwd: join(root, "second"), home });
    writeConfig(workspace.configPath, {
      version: 1,
      projects: [{ name: "selected", path: dirname(first.configPath) }],
    });
    expect(resolveProject({ cwd, home, project: "selected" })).toEqual(first);

    writeConfig(first.configPath, {
      version: 1,
      projectId: second.projectId,
      databasePath: second.databasePath,
    });

    expect(resolveProject({ cwd, home, project: "selected" })).toEqual({
      ...second,
      configPath: first.configPath,
    });
  });
});
