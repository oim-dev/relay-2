import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  initializeProject,
  restoreProject,
  resolveProject,
  runNativeProcess,
} from "@relay/project-runtime";
import { ProjectDatabase } from "@relay/storage";
import { RuntimeFixture, runtimeErrorCode } from "./helpers/runtime-fixture";

const group = "git-sync-implementation/review-runtime/late-writer";

/**
 * Материализует минимальную валидную replica и закрывает соединение до публикации Runtime.
 */
function writeReplica(path: string, id: string): void {
  const database = ProjectDatabase.create(path, {
    id,
    name: "Восстановленная память",
    slug: "restored",
  });
  database.close();
}

describe("Восстановление независимой реплики", () => {
  test("rollback после отказа config сохраняет подменённую БД и доказательство своей попытки", async () => {
    const fixture = new RuntimeFixture(group);
    const projectId = "interrupted-project";
    const databasePath = join(fixture.home, "projects", projectId, "project.sqlite");
    try {
      const result = await runNativeProcess({
        executable: process.execPath,
        args: [join(import.meta.dir, "restoration-worker.ts")],
        cwd: fixture.cwd,
        env: {
          ...process.env,
          HOME: fixture.root,
          USERPROFILE: fixture.root,
          RELAY_TEST_CWD: fixture.cwd,
          RELAY_TEST_HOME: fixture.home,
          RELAY_TEST_PROJECT: projectId,
          RELAY_TEST_REPLACE_ON_CONFIG_FAILURE: "1",
        },
        timeoutMs: 5000,
      });

      expect(result).toEqual({
        exitCode: 0,
        stdout: '{"code":"RESTORE_RECOVERY_REQUIRED"}\n',
        stderr: "",
      });
      const foreign = ProjectDatabase.open(databasePath);
      try {
        expect(foreign.projectId).toBe("foreign-project");
        expect(foreign.get("foreign-project")?.data.name).toBe("Чужая рабочая база");
      } finally {
        foreign.close();
      }
      expect(JSON.parse(readFileSync(join(fixture.cwd, "relay.config.json"), "utf8"))).toEqual({
        version: 1,
        projectId: "foreign-project",
        databasePath,
      });
      expect(resolveProject({ cwd: fixture.cwd, home: fixture.home })).toEqual({
        projectId: "foreign-project",
        databasePath,
        configPath: join(fixture.cwd, "relay.config.json"),
      });
      expect(existsSync(join(dirname(databasePath), ".restore-publication.json"))).toBe(true);
      expect(
        readdirSync(dirname(databasePath), { withFileTypes: true }).filter(
          (entry) => entry.isDirectory() && entry.name.startsWith(".restore-"),
        ),
      ).toHaveLength(1);
    } finally {
      await fixture.dispose();
    }
  });

  test.each(["-wal", "-shm"])(
    "появившийся во время подготовки %s сохраняется без публикации новой БД",
    async (suffix) => {
      const fixture = new RuntimeFixture(group);
      const databasePath = join(fixture.home, "projects", "restored", "project.sqlite");
      try {
        const code = runtimeErrorCode(() =>
          restoreProject({ cwd: fixture.cwd, home: fixture.home }, "restored", (path) => {
            writeReplica(path, "restored");
            // Независимый владелец создаёт журнал после первоначальной проверки свободного пути.
            writeFileSync(`${databasePath}${suffix}`, "unrecovered local changes");
          }),
        );

        expect(code).toBe("DATABASE_EXISTS");
        expect(readFileSync(`${databasePath}${suffix}`, "utf8")).toBe("unrecovered local changes");
        expect(existsSync(databasePath)).toBe(false);
        expect(existsSync(join(fixture.cwd, "relay.config.json"))).toBe(false);
        expect(readdirSync(dirname(databasePath)).sort()).toEqual([
          ".restore.lock.sqlite",
          `project.sqlite${suffix}`,
        ]);
      } finally {
        await fixture.dispose();
      }
    },
  );

  test.each([
    { name: "до hardlink БД", beforeDatabase: true, afterConfig: false },
    { name: "между hardlink и config", beforeDatabase: false, afterConfig: false },
    { name: "после config", beforeDatabase: false, afterConfig: true },
  ])(
    "авария $name сохраняет публикацию без автоматического adoption или нового materializer",
    async ({ beforeDatabase, afterConfig }) => {
      const fixture = new RuntimeFixture(group);
      const projectId = "interrupted-project";
      const databasePath = join(fixture.home, "projects", projectId, "project.sqlite");
      try {
        const crashed = await runNativeProcess({
          executable: process.execPath,
          args: [join(import.meta.dir, "restoration-worker.ts")],
          cwd: fixture.cwd,
          env: {
            ...process.env,
            HOME: fixture.root,
            USERPROFILE: fixture.root,
            RELAY_TEST_CWD: fixture.cwd,
            RELAY_TEST_HOME: fixture.home,
            RELAY_TEST_PROJECT: projectId,
            RELAY_TEST_AFTER_CONFIG: afterConfig ? "1" : "0",
            RELAY_TEST_BEFORE_DATABASE: beforeDatabase ? "1" : "0",
          },
          timeoutMs: 5000,
        });
        expect(crashed).toEqual({ exitCode: 73, stdout: "", stderr: "" });
        expect(existsSync(databasePath)).toBe(!beforeDatabase);
        expect(existsSync(join(fixture.cwd, "relay.config.json"))).toBe(afterConfig);
        let called = false;

        expect(
          runtimeErrorCode(() =>
            restoreProject({ cwd: fixture.cwd, home: fixture.home }, projectId, () => {
              called = true;
            }),
          ),
        ).toBe("RESTORE_RECOVERY_REQUIRED");
        expect(called).toBe(false);

        const staging = readdirSync(dirname(databasePath), { withFileTypes: true }).find(
          (entry) => entry.isDirectory() && entry.name.startsWith(".restore-"),
        );
        if (!staging) {
          throw new Error("Потерян staging незавершённой публикации");
        }
        const database = ProjectDatabase.open(
          join(dirname(databasePath), staging.name, "project.sqlite"),
        );
        try {
          expect(database.get(projectId)?.data.name).toBe("Прерванная копия");
        } finally {
          database.close();
        }
        expect(existsSync(join(dirname(databasePath), ".restore-publication.json"))).toBe(true);
        expect(existsSync(databasePath)).toBe(!beforeDatabase);
        expect(existsSync(join(fixture.cwd, "relay.config.json"))).toBe(afterConfig);
      } finally {
        await fixture.dispose();
      }
    },
  );

  test("recovery после аварии не удаляет чужую БД, занявшую тот же путь", async () => {
    const fixture = new RuntimeFixture(group);
    const projectId = "interrupted-project";
    const databasePath = join(fixture.home, "projects", projectId, "project.sqlite");
    try {
      const crashed = await runNativeProcess({
        executable: process.execPath,
        args: [join(import.meta.dir, "restoration-worker.ts")],
        cwd: fixture.cwd,
        env: {
          ...process.env,
          HOME: fixture.root,
          USERPROFILE: fixture.root,
          RELAY_TEST_CWD: fixture.cwd,
          RELAY_TEST_HOME: fixture.home,
          RELAY_TEST_PROJECT: projectId,
          RELAY_TEST_AFTER_CONFIG: "0",
        },
        timeoutMs: 5000,
      });
      expect(crashed.exitCode).toBe(73);
      rmSync(databasePath);
      writeReplica(databasePath, "foreign-project");
      const original = readFileSync(databasePath);

      const code = runtimeErrorCode(() =>
        restoreProject({ cwd: fixture.cwd, home: fixture.home }, projectId, () => {
          throw new Error("Нельзя начинать запись поверх чужой базы");
        }),
      );

      expect(code).toBe("RESTORE_RECOVERY_REQUIRED");
      expect(readFileSync(databasePath)).toEqual(original);
      expect(existsSync(join(fixture.cwd, "relay.config.json"))).toBe(false);
    } finally {
      await fixture.dispose();
    }
  });

  test("async callback отвергается до запуска и создания файлов", async () => {
    const fixture = new RuntimeFixture(group);
    let called = false;
    try {
      const code = runtimeErrorCode(() =>
        restoreProject({ cwd: fixture.cwd, home: fixture.home }, "restored", async () => {
          called = true;
        }),
      );

      expect(code).toBe("INVALID_ARGUMENT");
      expect(called).toBe(false);
      expect(existsSync(fixture.home)).toBe(false);
      expect(readdirSync(fixture.cwd)).toEqual([]);
    } finally {
      await fixture.dispose();
    }
  });

  test("оставшийся WAL утраченной базы сохраняется без запуска materializer", async () => {
    const fixture = new RuntimeFixture(group);
    try {
      const original = initializeProject({ cwd: fixture.cwd, home: fixture.home });
      rmSync(original.databasePath);
      writeFileSync(`${original.databasePath}-wal`, "unrecovered local changes");
      let called = false;

      const code = runtimeErrorCode(() =>
        restoreProject({ cwd: fixture.cwd, home: fixture.home }, original.projectId, () => {
          called = true;
        }),
      );

      expect(code).toBe("DATABASE_EXISTS");
      expect(called).toBe(false);
      expect(readFileSync(`${original.databasePath}-wal`, "utf8")).toBe(
        "unrecovered local changes",
      );
      expect(existsSync(original.databasePath)).toBe(false);
    } finally {
      await fixture.dispose();
    }
  });

  test("новый каталог получает совместимую БД и эксклюзивный config без предварительного init", async () => {
    const fixture = new RuntimeFixture(group);
    try {
      const location = restoreProject(
        { cwd: fixture.cwd, home: fixture.home },
        "project-restored",
        (path) => writeReplica(path, "project-restored"),
      );

      expect(location.databasePath).toBe(
        join(fixture.home, "projects/project-restored/project.sqlite"),
      );
      expect(JSON.parse(readFileSync(location.configPath, "utf8"))).toEqual({
        version: 1,
        projectId: "project-restored",
      });
      expect(resolveProject({ cwd: fixture.cwd, home: fixture.home })).toEqual(location);
      expect(
        readdirSync(dirname(location.databasePath)).some((name) => name.startsWith(".restore-")),
      ).toBe(false);
    } finally {
      await fixture.dispose();
    }
  });

  test("явное восстановление утраченной БД сохраняет существующий конфиг того же ID", async () => {
    const fixture = new RuntimeFixture(group);
    try {
      const original = initializeProject({ cwd: fixture.cwd, home: fixture.home });
      const config = readFileSync(original.configPath, "utf8");
      rmSync(original.databasePath);

      const restored = restoreProject(
        { cwd: fixture.cwd, home: fixture.home },
        original.projectId,
        (path) => writeReplica(path, original.projectId),
      );

      expect(restored).toEqual(original);
      expect(readFileSync(original.configPath, "utf8")).toBe(config);
      expect(resolveProject({ cwd: fixture.cwd, home: fixture.home })).toEqual(original);
    } finally {
      await fixture.dispose();
    }
  });

  test("рабочая БД не заменяется и callback не запускается", async () => {
    const fixture = new RuntimeFixture(group);
    try {
      const original = initializeProject({ cwd: fixture.cwd, home: fixture.home });
      const bytes = readFileSync(original.databasePath);
      let called = false;

      const code = runtimeErrorCode(() =>
        restoreProject({ cwd: fixture.cwd, home: fixture.home }, original.projectId, () => {
          called = true;
        }),
      );

      expect(code).toBe("DATABASE_EXISTS");
      expect(called).toBe(false);
      expect(readFileSync(original.databasePath)).toEqual(bytes);
      expect(resolveProject({ cwd: fixture.cwd, home: fixture.home })).toEqual(original);
    } finally {
      await fixture.dispose();
    }
  });

  test("несовпадение ID materialized БД не публикует config и убирает только staging", async () => {
    const fixture = new RuntimeFixture(group);
    try {
      const code = runtimeErrorCode(() =>
        restoreProject({ cwd: fixture.cwd, home: fixture.home }, "expected", (path) =>
          writeReplica(path, "foreign"),
        ),
      );

      expect(code).toBe("PROJECT_ID_MISMATCH");
      expect(existsSync(join(fixture.cwd, "relay.config.json"))).toBe(false);
      expect(existsSync(join(fixture.home, "projects/expected/project.sqlite"))).toBe(false);
      expect(readdirSync(join(fixture.home, "projects/expected"))).toEqual([
        ".restore.lock.sqlite",
      ]);
    } finally {
      await fixture.dispose();
    }
  });

  test("проигрыш публикации config сохраняет чужой файл, опубликованную БД и intent", async () => {
    const fixture = new RuntimeFixture(group);
    const configPath = join(fixture.cwd, "relay.config.json");
    const foreign = JSON.stringify({ version: 1, projectId: "winner" });
    try {
      const code = runtimeErrorCode(() =>
        restoreProject({ cwd: fixture.cwd, home: fixture.home }, "candidate", (path) => {
          writeReplica(path, "candidate");
          // Конкурент публикует config после подготовки, но до эксклюзивного link Runtime.
          writeFileSync(configPath, foreign);
        }),
      );

      expect(code).toBe("RESTORE_RECOVERY_REQUIRED");
      expect(readFileSync(configPath, "utf8")).toBe(foreign);
      const directory = join(fixture.home, "projects/candidate");
      const database = ProjectDatabase.open(join(directory, "project.sqlite"));
      try {
        expect(database.projectId).toBe("candidate");
        expect(database.get("candidate")?.data.name).toBe("Восстановленная память");
      } finally {
        database.close();
      }
      expect(existsSync(join(directory, ".restore-publication.json"))).toBe(true);
    } finally {
      await fixture.dispose();
    }
  });

  test("несовпадающий существующий config отвергается без callback и без создания другой реплики", async () => {
    const fixture = new RuntimeFixture(group);
    try {
      const original = initializeProject({ cwd: fixture.cwd, home: fixture.home });
      let called = false;

      const code = runtimeErrorCode(() =>
        restoreProject({ cwd: fixture.cwd, home: fixture.home }, "foreign", () => {
          called = true;
        }),
      );

      expect(code).toBe("PROJECT_ID_MISMATCH");
      expect(called).toBe(false);
      expect(resolveProject({ cwd: fixture.cwd, home: fixture.home })).toEqual(original);
      expect(existsSync(join(fixture.home, "projects/foreign"))).toBe(false);
    } finally {
      await fixture.dispose();
    }
  });
});
