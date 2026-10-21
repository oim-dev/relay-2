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
  { name: "неполный проект", contents: JSON.stringify({ version: 1, projectId: "id" }) },
  {
    name: "пустой путь",
    contents: JSON.stringify({ version: 1, projectId: "id", databasePath: "" }),
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
      const path = join(cwd, ".relay", "config.json");
      mkdirSync(dirname(path));
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

  test("повреждённый ближайший конфиг не пропускается ради родительского", () => {
    const { cwd, home } = fixture;
    initializeProject({ cwd, home });
    const nested = join(cwd, "nested");
    writeConfig(join(nested, ".relay", "config.json"), {});

    const code = runtimeErrorCode(() => resolveProject({ cwd: nested, home }));

    expect(code).toBe("INVALID_CONFIG");
  });

  test("каталог вместо конфига отклоняется при чтении и сохраняется при init", () => {
    const { cwd, home } = fixture;
    const path = join(cwd, ".relay", "config.json");
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
    const path = join(cwd, ".relay", "config.json");
    const absent = join(root, "absent.json");
    mkdirSync(dirname(path));
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
        { name: "same", configPath: "a" },
        { name: "same", configPath: "b" },
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
      projects: [{ name: "loop", configPath: workspace.configPath }],
    });

    const code = runtimeErrorCode(() => resolveProject({ cwd, home, project: "loop" }));

    expect(code).toBe("INVALID_CONFIG");
  });

  test("проектный config не подходит для чтения списка регистраций", () => {
    const { cwd, home } = fixture;
    const project = initializeProject({ cwd, home });

    const code = runtimeErrorCode(() => listProjects({ cwd, home, config: project.configPath }));

    expect(code).toBe("WORKSPACE_REQUIRED");
  });
});
