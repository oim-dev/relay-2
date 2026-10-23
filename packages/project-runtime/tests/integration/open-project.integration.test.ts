import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, renameSync, symlinkSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import {
  initializeProject,
  initializeWorkspace,
  openProject,
  registerProject,
  resolveProject,
} from "@relay/project-runtime";
import { ProjectDatabase } from "@relay/storage";
import { RuntimeFixture, runtimeErrorCode, writeConfig } from "./helpers/runtime-fixture";

const invalidSelections = [
  { name: "пустой home", options: { home: "" }, code: "INVALID_ARGUMENT" },
  {
    name: "селектор с явным проектным конфигом",
    options: { config: "relay.config.json", project: "selected" },
    code: "WORKSPACE_REQUIRED",
  },
] as const;

describe("Передача рабочего соединения Project Runtime", () => {
  let fixture: RuntimeFixture;

  beforeEach(() => {
    fixture = new RuntimeFixture("get-batch/cli-open-project");
  });

  afterEach(async () => {
    await fixture.dispose();
  });

  test("openProject открывает ровно одно рабочее соединение и передаёт закрытие вызывающему", () => {
    const { cwd, home } = fixture;
    const options = { cwd, home: relative(cwd, home), config: "settings/project.json" };
    const expected = initializeProject({ ...options, name: "Открытый проект" });
    const open = spyOn(ProjectDatabase, "open");
    const close = spyOn(ProjectDatabase.prototype, "close");
    try {
      const project = openProject(options);
      try {
        expect(open).toHaveBeenCalledTimes(1);
        expect(open).toHaveBeenCalledWith(expected.databasePath);
        expect(close).not.toHaveBeenCalled();
        expect(project.location).toEqual(expected);
        expect(project.database.get("PROJECT")).toMatchObject({
          id: expected.projectId,
          data: { name: "Открытый проект" },
        });
      } finally {
        project.database.close();
      }
      expect(close).toHaveBeenCalledTimes(1);
      expect(() => project.database.get("PROJECT")).toThrow();
    } finally {
      open.mockRestore();
      close.mockRestore();
    }
  });

  test("resolveProject сохраняет проверку и закрывает своё единственное соединение", () => {
    const { cwd, home } = fixture;
    const expected = initializeProject({ cwd, home });
    const open = spyOn(ProjectDatabase, "open");
    const close = spyOn(ProjectDatabase.prototype, "close");
    try {
      const location = resolveProject({ cwd, home });

      expect(location).toEqual(expected);
      expect(open).toHaveBeenCalledTimes(1);
      expect(close).toHaveBeenCalledTimes(1);
    } finally {
      open.mockRestore();
      close.mockRestore();
    }
  });

  test("регистрация workspace проверяет проект и закрывает probe без передачи соединения", () => {
    const { cwd, home, root } = fixture;
    initializeWorkspace({ cwd, home });
    const project = initializeProject({ cwd: join(root, "registered"), home });
    const open = spyOn(ProjectDatabase, "open");
    const close = spyOn(ProjectDatabase.prototype, "close");
    try {
      registerProject({ cwd, home }, "selected", dirname(project.configPath));

      expect(open).toHaveBeenCalledTimes(1);
      expect(open).toHaveBeenCalledWith(project.databasePath);
      expect(close).toHaveBeenCalledTimes(1);
    } finally {
      open.mockRestore();
      close.mockRestore();
    }
  });

  test("workspace и symlink используют физические относительные пути и явную базу одним open", () => {
    const { cwd, home, root } = fixture;
    const workspace = initializeWorkspace({ cwd, home });
    const expected = initializeProject({ cwd: join(cwd, "projects", "selected"), home });
    writeConfig(expected.configPath, {
      version: 1,
      projectId: expected.projectId,
      databasePath: relative(dirname(expected.configPath), expected.databasePath),
    });
    const projectAlias = join(cwd, "projects", "alias");
    symlinkSync(dirname(expected.configPath), projectAlias);
    writeConfig(workspace.configPath, {
      version: 1,
      projects: [{ name: "selected", path: "projects/alias" }],
    });
    symlinkSync(workspace.configPath, join(root, "workspace-link.json"));
    const open = spyOn(ProjectDatabase, "open");
    try {
      const project = openProject({
        cwd: root,
        home: "other-home",
        config: "workspace-link.json",
        project: "selected",
      });
      try {
        expect(project.location).toEqual({
          ...expected,
          configPath: join(projectAlias, "relay.config.json"),
        });
        expect(project.database.get("PROJECT")?.id).toBe(expected.projectId);
        expect(open).toHaveBeenCalledTimes(1);
        expect(existsSync(join(root, "other-home"))).toBe(false);
      } finally {
        project.database.close();
      }
    } finally {
      open.mockRestore();
    }
  });

  test("несовпадение ID закрывает единственное новое соединение до передачи вызывающему", () => {
    const { cwd, home } = fixture;
    const project = initializeProject({ cwd, home });
    writeConfig(project.configPath, {
      version: 1,
      projectId: "different-id",
      databasePath: project.databasePath,
    });
    const open = spyOn(ProjectDatabase, "open");
    const close = spyOn(ProjectDatabase.prototype, "close");
    try {
      const code = runtimeErrorCode(() => openProject({ cwd, home }));

      expect(code).toBe("PROJECT_ID_MISMATCH");
      expect(open).toHaveBeenCalledTimes(1);
      expect(close).toHaveBeenCalledTimes(1);
    } finally {
      open.mockRestore();
      close.mockRestore();
    }
  });

  test("несовместимая схема сохраняет ошибку Storage и закрывает низкоуровневое соединение", () => {
    const { cwd, home } = fixture;
    const project = initializeProject({ cwd, home });
    const raw = new Database(project.databasePath);
    try {
      raw.exec("PRAGMA user_version = 2147483647");
    } finally {
      raw.close();
    }
    const open = spyOn(ProjectDatabase, "open");
    const close = spyOn(Database.prototype, "close");
    try {
      const code = runtimeErrorCode(() => openProject({ cwd, home }));

      expect(code).toBe("SCHEMA_VERSION_UNSUPPORTED");
      expect(open).toHaveBeenCalledTimes(1);
      expect(close).toHaveBeenCalledTimes(1);
    } finally {
      open.mockRestore();
      close.mockRestore();
    }
  });

  test("потерянная база не создаётся при открытии рабочего проекта", () => {
    const { cwd, home } = fixture;
    const project = initializeProject({ cwd, home });
    renameSync(project.databasePath, `${project.databasePath}.saved`);

    const code = runtimeErrorCode(() => openProject({ cwd, home }));

    expect(code).toBe("DATABASE_NOT_FOUND");
    expect(existsSync(project.databasePath)).toBe(false);
    expect(existsSync(`${project.databasePath}.saved`)).toBe(true);
  });

  test.each(invalidSelections)("$name отклоняется до открытия базы", ({ options, code }) => {
    const { cwd, home } = fixture;
    initializeProject({ cwd, home });
    const open = spyOn(ProjectDatabase, "open");
    try {
      const actualCode = runtimeErrorCode(() => openProject({ cwd, home, ...options }));

      expect(actualCode).toBe(code);
      expect(open).not.toHaveBeenCalled();
    } finally {
      open.mockRestore();
    }
  });
});
