import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import {
  initializeProject,
  initializeWorkspace,
  inspectRelayHome,
  openProject,
  registerProject,
} from "@relay/project-runtime";
import { RuntimeFixture } from "./helpers/runtime-fixture";

const workspaceSelections = [
  { name: "выбранная регистрация", project: "first", current: true, errorCode: null },
  {
    name: "неизвестная регистрация",
    project: "missing",
    current: false,
    errorCode: "PROJECT_NOT_FOUND",
  },
];

describe("Глобальное readonly-состояние Relay home", () => {
  test("вне проекта видны все базы home; вложенный cwd только подсвечивает текущую", async () => {
    const fixture = new RuntimeFixture("dev-mode-test-review/status-fixtures");
    try {
      const a = join(fixture.root, "a");
      const b = join(fixture.root, "b");
      const foreign = join(fixture.root, "foreign");
      for (const path of [a, b, foreign]) {
        mkdirSync(path);
      }
      const first = initializeProject({
        cwd: a,
        home: fixture.home,
        name: "Первый",
        slug: "first",
      });
      const second = initializeProject({
        cwd: b,
        home: fixture.home,
        name: "Второй",
        slug: "second",
      });
      initializeProject({
        cwd: foreign,
        home: join(fixture.root, "other-home"),
        name: "Другой home",
        slug: "other",
      });
      const nested = join(a, "src", "nested");
      mkdirSync(nested, { recursive: true });

      const outside = inspectRelayHome({ cwd: fixture.cwd, home: fixture.home });
      const inside = inspectRelayHome({ cwd: nested, home: fixture.home });

      expect(outside.context).toMatchObject({ configPath: null, projectConfigPath: null });
      expect(outside.projects.map((project) => project.projectId).sort()).toEqual(
        [first.projectId, second.projectId].sort(),
      );
      expect(outside.projects.every((project) => project.available && !project.current)).toBe(true);
      expect(outside.projects.every((project) => project.configPaths.length === 0)).toBe(true);
      expect(inside.projects).toHaveLength(2);
      expect(inside.projects.find((project) => project.current)).toMatchObject({
        projectId: first.projectId,
        name: "Первый",
        databasePath: first.databasePath,
        configPaths: [first.configPath],
        synchronization: "auto",
      });
      expect(inside.context.configPath).toBe(first.configPath);
    } finally {
      await fixture.dispose();
    }
  });

  test("повреждённая БД и конфиг сохраняют отдельные ошибки, доступный проект остаётся виден", async () => {
    const fixture = new RuntimeFixture("dev-mode-test-review/status-fixtures");
    try {
      const project = initializeProject({
        cwd: fixture.cwd,
        home: fixture.home,
        name: "Доступный",
        slug: "available",
      });
      const directory = join(fixture.home, "projects", "broken");
      mkdirSync(directory);
      const database = join(directory, "project.sqlite");
      const bytes = "Это не SQLite";
      writeFileSync(database, bytes);
      const missing = join(fixture.root, "missing.json");

      const observed = inspectRelayHome({ cwd: fixture.cwd, home: fixture.home, config: missing });

      expect(observed.context.error?.code).toBe("CONFIG_NOT_FOUND");
      expect(
        observed.projects.find((entry) => entry.projectId === project.projectId)?.available,
      ).toBe(true);
      expect(observed.projects.find((entry) => entry.projectId === "broken")).toMatchObject({
        available: false,
        name: null,
        error: { code: "STORAGE_ERROR" },
      });
      expect(readFileSync(database, "utf8")).toBe(bytes);
      expect(existsSync(missing)).toBe(false);
    } finally {
      await fixture.dispose();
    }
  });

  test("относительный knownConfig разрешается от options.cwd и раскрывает workspace без фильтрации home", async () => {
    const fixture = new RuntimeFixture("dev-mode-test-review/status-fixtures");
    try {
      const projectDir = join(fixture.root, "project");
      mkdirSync(projectDir);
      const project = initializeProject({
        cwd: projectDir,
        home: fixture.home,
        name: "Проект",
        slug: "project",
      });
      const unregistered = initializeProject({
        cwd: join(fixture.root, "unregistered"),
        home: fixture.home,
        name: "Вне workspace",
      });
      const workspace = initializeWorkspace({ cwd: fixture.cwd, home: fixture.home });
      registerProject({ cwd: fixture.cwd, home: fixture.home }, "project", projectDir);

      const observed = inspectRelayHome({ cwd: fixture.root, home: fixture.home }, [
        relative(fixture.root, workspace.configPath),
      ]);

      expect(observed.context.configPath).toBeNull();
      expect(observed.configurations).toHaveLength(2);
      expect(observed.projects).toHaveLength(2);
      expect(
        observed.projects.find((entry) => entry.projectId === project.projectId),
      ).toMatchObject({
        projectId: project.projectId,
        configPaths: [project.configPath],
        current: false,
      });
      expect(
        observed.projects.find((entry) => entry.projectId === unregistered.projectId),
      ).toMatchObject({
        available: true,
        name: "Вне workspace",
        configPaths: [],
        current: false,
      });
    } finally {
      await fixture.dispose();
    }
  });

  test("пустой home не создаётся при диагностике вне проекта", async () => {
    const fixture = new RuntimeFixture("dev-mode-test-review/status-fixtures");
    try {
      const observed = inspectRelayHome({ cwd: fixture.cwd, home: fixture.home });

      expect(observed.projects).toEqual([]);
      expect(observed.configurations).toEqual([]);
      expect(existsSync(fixture.home)).toBe(false);
    } finally {
      await fixture.dispose();
    }
  });

  test.each(workspaceSelections)(
    "$name меняет только подсветку, а не полный набор баз home",
    async ({ project, current, errorCode }) => {
      const fixture = new RuntimeFixture("dev-mode-test-review/status-fixtures");
      try {
        const first = initializeProject({ cwd: join(fixture.root, "first"), home: fixture.home });
        const second = initializeProject({ cwd: join(fixture.root, "second"), home: fixture.home });
        initializeWorkspace({ cwd: fixture.cwd, home: fixture.home });
        registerProject(
          { cwd: fixture.cwd, home: fixture.home },
          "first",
          join(fixture.root, "first"),
        );
        registerProject(
          { cwd: fixture.cwd, home: fixture.home },
          "second",
          join(fixture.root, "second"),
        );
        const nested = join(fixture.cwd, "nested");
        mkdirSync(nested);

        const observed = inspectRelayHome({ cwd: nested, home: fixture.home, project });

        expect(observed.projects.map((entry) => entry.projectId).sort()).toEqual(
          [first.projectId, second.projectId].sort(),
        );
        expect(
          observed.projects.filter((entry) => entry.current).map((entry) => entry.projectId),
        ).toEqual(current ? [first.projectId] : []);
        expect(observed.context.projectConfigPath).toBe(current ? first.configPath : null);
        expect(observed.context.error?.code ?? null).toBe(errorCode);
      } finally {
        await fixture.dispose();
      }
    },
  );

  test("явный databasePath раскрывает внешнюю реплику того же ID, не подсвечивая стандартную БД", async () => {
    const fixture = new RuntimeFixture("dev-mode-test-review/status-fixtures");
    try {
      const original = initializeProject({
        cwd: fixture.cwd,
        home: fixture.home,
        name: "Исходная БД",
      });
      const external = join(fixture.root, "external.sqlite");
      copyFileSync(original.databasePath, external);
      const config = join(fixture.root, "external.json");
      writeFileSync(
        config,
        JSON.stringify({
          version: 1,
          projectId: original.projectId,
          databasePath: "external.sqlite",
        }),
      );
      const { database } = openProject({ cwd: fixture.root, home: fixture.home, config });
      try {
        database.setSynchronizationMode("manual");
      } finally {
        database.close();
      }

      const observed = inspectRelayHome(
        { cwd: fixture.cwd, home: fixture.home, config: "../external.json" },
        [original.configPath, config],
      );

      expect(observed.projects).toHaveLength(2);
      expect(observed.context.projectConfigPath).toBe(config);
      expect(observed.projects.find((entry) => entry.databasePath === external)).toMatchObject({
        projectId: original.projectId,
        available: true,
        current: true,
        synchronization: "manual",
        configPaths: [config],
      });
      expect(
        observed.projects.find((entry) => entry.databasePath === original.databasePath),
      ).toMatchObject({
        projectId: original.projectId,
        available: true,
        current: false,
        synchronization: "auto",
        configPaths: [original.configPath],
      });
    } finally {
      await fixture.dispose();
    }
  });

  test("глобальная диагностика не мигрирует старую БД и не создаёт утраченную", async () => {
    const fixture = new RuntimeFixture("dev-mode-test-review/status-fixtures");
    try {
      const legacy = initializeProject({ cwd: fixture.cwd, home: fixture.home });
      const healthy = initializeProject({ cwd: join(fixture.root, "healthy"), home: fixture.home });
      // Валидная v4 получается удалением единственной таблицы, добавленной миграцией v5.
      const raw = new Database(legacy.databasePath);
      try {
        raw.exec("DROP TABLE synchronization_schedule; PRAGMA user_version=4");
      } finally {
        raw.close();
      }
      const before = readFileSync(legacy.databasePath);
      const missing = join(fixture.home, "projects", "missing", "project.sqlite");
      mkdirSync(join(fixture.home, "projects", "missing"));

      const observed = inspectRelayHome({ cwd: fixture.cwd, home: fixture.home });

      expect(observed.projects).toHaveLength(3);
      expect(observed.projects.find((entry) => entry.projectId === legacy.projectId)).toMatchObject(
        {
          available: false,
          synchronization: null,
          error: { code: "SCHEMA_VERSION_UNSUPPORTED" },
        },
      );
      expect(observed.projects.find((entry) => entry.projectId === "missing")).toMatchObject({
        available: false,
        error: { code: "DATABASE_NOT_FOUND" },
      });
      expect(
        observed.projects.find((entry) => entry.projectId === healthy.projectId)?.available,
      ).toBe(true);
      expect(readFileSync(legacy.databasePath)).toEqual(before);
      expect(existsSync(missing)).toBe(false);
    } finally {
      await fixture.dispose();
    }
  });

  test("посторонний ID каталога не присваивает себе исправную чужую БД", async () => {
    const fixture = new RuntimeFixture("dev-mode-test-review/status-fixtures");
    try {
      const original = initializeProject({ cwd: fixture.cwd, home: fixture.home });
      const wrongDirectory = join(fixture.home, "projects", "wrong-id");
      mkdirSync(wrongDirectory);
      const copied = join(wrongDirectory, "project.sqlite");
      copyFileSync(original.databasePath, copied);
      const before = readFileSync(copied);

      const observed = inspectRelayHome({ cwd: fixture.cwd, home: fixture.home });

      expect(observed.projects).toHaveLength(2);
      expect(observed.projects.find((entry) => entry.projectId === "wrong-id")).toMatchObject({
        databasePath: copied,
        name: null,
        current: false,
        available: false,
        error: { code: "PROJECT_ID_MISMATCH" },
      });
      expect(
        observed.projects.find((entry) => entry.projectId === original.projectId)?.available,
      ).toBe(true);
      expect(readFileSync(copied)).toEqual(before);
    } finally {
      await fixture.dispose();
    }
  });
});
