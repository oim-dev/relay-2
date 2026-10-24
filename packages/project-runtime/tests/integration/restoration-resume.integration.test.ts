import { describe, expect, test } from "bun:test";
import { Database, constants } from "bun:sqlite";
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { RelayError } from "@relay/contracts";
import {
  openProject,
  restoreProject,
  resumeProjectRestoration,
  runNativeProcess,
} from "@relay/project-runtime";
import { ProjectDatabase } from "@relay/storage";
import { RuntimeFixture, runtimeErrorCode } from "./helpers/runtime-fixture";
import type {
  PendingRestorationFixture,
  PreservedRestorationData,
} from "./restoration-resume.test.types";

const group = "git-sync-implementation/review-runtime/late-writer/resume";
const projectId = "resume-project";

/**
 * Находит только staging конкретного известного projectId в fixture, не подменяя discovery API.
 */
function pendingPaths(fixture: RuntimeFixture): PendingRestorationFixture {
  const databasePath = join(fixture.home, "projects", projectId, "project.sqlite");
  const directories = readdirSync(dirname(databasePath), { withFileTypes: true }).filter(
    (entry) => entry.isDirectory() && entry.name.startsWith(".restore-"),
  );
  const staging = directories[0];
  if (directories.length !== 1 || !staging) {
    throw new Error("Не найден единственный staging fixture");
  }
  return {
    location: { projectId, databasePath, configPath: join(fixture.cwd, "relay.config.json") },
    stagingPath: join(dirname(databasePath), staging.name),
    publicationPath: join(dirname(databasePath), ".restore-publication.json"),
  };
}

/**
 * Создаёт реальные SQLite/intent и завершает worker на выбранной границе без разворачивания finally.
 */
async function createInterruptedPublication(
  fixture: RuntimeFixture,
  phase: "before-link" | "before-config" | "after-config",
): Promise<PendingRestorationFixture> {
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
      RELAY_TEST_BEFORE_DATABASE: phase === "before-link" ? "1" : "0",
      RELAY_TEST_AFTER_CONFIG: phase === "after-config" ? "1" : "0",
      RELAY_TEST_REPLACE_ON_CONFIG_FAILURE: "0",
    },
    timeoutMs: 10_000,
  });
  expect(result).toEqual({ exitCode: 73, stdout: "", stderr: "" });
  const pending = pendingPaths(fixture);
  expect(JSON.parse(readFileSync(pending.publicationPath, "utf8"))).toMatchObject({
    version: 3,
    transfer: process.platform === "win32" ? "hardlink" : "rename",
  });
  return pending;
}

/**
 * Проверяет сохранённый проект одним read snapshot и закрывает соединение; никаких предметных мутаций.
 */
function readPreservedData(path: string): PreservedRestorationData {
  const database = ProjectDatabase.openReadonly(path);
  try {
    return database.snapshot(() => {
      const project = database.get(projectId);
      if (!project) {
        throw new Error("В fixture отсутствует ожидаемый проект");
      }
      return {
        project,
        replicaId: database.getReplicationState().replicaId,
        outbox: database.getReplicationOutbox(),
      };
    });
  } finally {
    database.close();
  }
}

/**
 * Имитирует только read-only границу Core: ID/schema уже проверил Runtime, snapshot читает public Storage API.
 */
function validatePreservedData(path: string): void {
  const data = readPreservedData(path);
  expect(data.project.kind).toBe("project");
}

/**
 * Прерывает реальный resume после private marker либо directory; общий intent ещё не удалён.
 */
async function interruptCleanup(
  fixture: RuntimeFixture,
  phase: "after-private-marker" | "after-directory",
): Promise<PendingRestorationFixture> {
  const pending = await createInterruptedPublication(fixture, "before-config");
  const result = await runNativeProcess({
    executable: process.execPath,
    args: [join(import.meta.dir, "restoration-resume-worker.ts")],
    cwd: fixture.cwd,
    env: {
      ...process.env,
      HOME: fixture.root,
      USERPROFILE: fixture.root,
      RELAY_TEST_CWD: fixture.cwd,
      RELAY_TEST_HOME: fixture.home,
      RELAY_TEST_PROJECT: projectId,
      RELAY_TEST_CLEANUP_CRASH: phase,
    },
    timeoutMs: 10_000,
  });
  expect(result).toEqual({ exitCode: 73, stdout: "", stderr: "" });
  return pending;
}

describe("Явное продолжение публикации restore", () => {
  test.each(["after-private-marker", "after-directory"] as const)(
    "cleanup crash %s завершается повторным resume без вечного intent",
    async (phase) => {
      const fixture = new RuntimeFixture(group);
      try {
        const pending = await interruptCleanup(fixture, phase);
        const before = readPreservedData(pending.location.databasePath);
        const config = readFileSync(pending.location.configPath);

        const result = resumeProjectRestoration(
          { cwd: fixture.cwd, home: fixture.home },
          projectId,
          validatePreservedData,
        );

        expect(result.recovery).toBeNull();
        expect(readPreservedData(pending.location.databasePath)).toEqual(before);
        expect(readFileSync(pending.location.configPath)).toEqual(config);
        expect(existsSync(pending.stagingPath)).toBe(false);
        expect(existsSync(pending.publicationPath)).toBe(false);
      } finally {
        await fixture.dispose();
      }
    },
  );

  test("скопированный единственный intent после cleanup crash отклоняется без validator", async () => {
    const fixture = new RuntimeFixture(group);
    let called = false;
    try {
      const pending = await interruptCleanup(fixture, "after-directory");
      const before = readPreservedData(pending.location.databasePath);
      const marker = readFileSync(pending.publicationPath);
      renameSync(pending.publicationPath, join(fixture.root, "original-intent"));
      writeFileSync(pending.publicationPath, marker);

      expect(
        runtimeErrorCode(() =>
          resumeProjectRestoration({ cwd: fixture.cwd, home: fixture.home }, projectId, () => {
            called = true;
          }),
        ),
      ).toBe("RESTORE_RECOVERY_REQUIRED");

      expect(called).toBe(false);
      expect(readPreservedData(pending.location.databasePath)).toEqual(before);
      expect(readFileSync(pending.publicationPath)).toEqual(marker);
    } finally {
      await fixture.dispose();
    }
  });

  test("legacy v2 с живым public WAL отклоняется до validator без unlink alias и потери outbox", async () => {
    const fixture = new RuntimeFixture(group);
    let opened: ProjectDatabase | undefined;
    let called = false;
    try {
      const pending = await createInterruptedPublication(fixture, "before-config");
      const staged = join(pending.stagingPath, "project.sqlite");
      // Настоящая форма старого v2: два имени одного datafile и прежний manifest.
      if (!existsSync(staged)) {
        linkSync(pending.location.databasePath, staged);
      }
      const intent = JSON.parse(readFileSync(pending.publicationPath, "utf8"));
      intent.version = 2;
      delete intent.transfer;
      writeFileSync(pending.publicationPath, JSON.stringify(intent));
      opened = ProjectDatabase.open(pending.location.databasePath);
      const initial = opened.get(projectId);
      if (!initial) {
        throw new Error("Не найден проект legacy fixture");
      }
      opened.update(
        {
          ...initial,
          revision: initial.revision + 1,
          data: { ...initial.data, name: "Legacy late write" },
        },
        initial.revision,
      );
      const outbox = opened.getReplicationOutbox();

      expect(() =>
        resumeProjectRestoration({ cwd: fixture.cwd, home: fixture.home }, projectId, () => {
          called = true;
        }),
      ).toThrow(
        expect.objectContaining({
          code: "RESTORE_RECOVERY_REQUIRED",
          details: expect.objectContaining({ reason: "legacy-publication", version: 2 }),
        }),
      );

      expect(called).toBe(false);
      expect(existsSync(staged)).toBe(true);
      expect(existsSync(pending.publicationPath)).toBe(true);
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(opened.getReplicationOutbox()).toEqual(outbox);
      expect(opened.get(projectId)?.data.name).toBe("Legacy late write");
    } finally {
      opened?.close();
      await fixture.dispose();
    }
  });

  test("закрытый persistent WAL private staging сохраняет позднюю запись, replicaId и outbox при resume", async () => {
    const fixture = new RuntimeFixture(group);
    try {
      const pending = await createInterruptedPublication(fixture, "before-link");
      const path = join(pending.stagingPath, "project.sqlite");
      const writer = ProjectDatabase.open(path);
      const raw = new Database(path, { create: false, readwrite: true });
      try {
        const initial = writer.get(projectId);
        if (!initial) {
          throw new Error("В fixture отсутствует проект");
        }
        writer.update(
          {
            ...initial,
            revision: initial.revision + 1,
            data: { ...initial.data, name: "Сохранённый WAL" },
          },
          initial.revision,
        );
        expect(raw.fileControl(constants.SQLITE_FCNTL_PERSIST_WAL, new Int32Array([1, 0]))).toBe(0);
        raw.query("SELECT * FROM project_state").get();
      } finally {
        writer.close();
        raw.close(true);
      }
      expect(existsSync(`${path}-wal`)).toBe(true);
      const before = readPreservedData(path);
      expect(existsSync(`${path}-wal`)).toBe(true);

      const result = resumeProjectRestoration(
        { cwd: fixture.cwd, home: fixture.home },
        projectId,
        validatePreservedData,
      );

      expect(result.recovery).toBeNull();
      expect(before.project).toMatchObject({ revision: 2, data: { name: "Сохранённый WAL" } });
      expect(before.outbox).toHaveLength(2);
      expect(readPreservedData(pending.location.databasePath)).toEqual(before);
      expect(existsSync(pending.stagingPath)).toBe(false);
    } finally {
      await fixture.dispose();
    }
  });

  test("подмена target после публикации config не выдаётся за успешный resume с cleanup warning", async () => {
    const fixture = new RuntimeFixture(group);
    try {
      const pending = await createInterruptedPublication(fixture, "before-config");
      const intentBytes = readFileSync(pending.publicationPath);
      const stagedPath = join(pending.stagingPath, "project.sqlite");
      const stagedBytes = existsSync(stagedPath) ? readFileSync(stagedPath) : null;

      const result = await runNativeProcess({
        executable: process.execPath,
        args: [join(import.meta.dir, "restoration-resume-worker.ts")],
        cwd: fixture.cwd,
        env: {
          ...process.env,
          HOME: fixture.root,
          USERPROFILE: fixture.root,
          RELAY_TEST_CWD: fixture.cwd,
          RELAY_TEST_HOME: fixture.home,
          RELAY_TEST_PROJECT: projectId,
        },
        timeoutMs: 10_000,
      });

      expect(result).toEqual({
        exitCode: 0,
        stdout: '{"code":"RESTORE_RECOVERY_REQUIRED"}\n',
        stderr: "",
      });
      expect(readPreservedData(pending.location.databasePath).project.data.name).toBe(
        "Подмена после привязки",
      );
      expect(readFileSync(pending.publicationPath)).toEqual(intentBytes);
      expect(existsSync(stagedPath) ? readFileSync(stagedPath) : null).toEqual(stagedBytes);
      expect(existsSync(pending.publicationPath)).toBe(true);
    } finally {
      await fixture.dispose();
    }
  });

  test("ID реальной БД проверяется до validator даже при совпадающих config и intent", async () => {
    const fixture = new RuntimeFixture(group);
    let called = false;
    try {
      const pending = await createInterruptedPublication(fixture, "before-config");
      // Config/intent намеренно заявляют другой ID, сохраняя настоящий inode проекта fixture.
      const intent = JSON.parse(readFileSync(pending.publicationPath, "utf8"));
      intent.projectId = "declared-but-foreign";
      writeFileSync(pending.publicationPath, JSON.stringify(intent));
      writeFileSync(
        pending.location.configPath,
        JSON.stringify({
          version: 1,
          projectId: "declared-but-foreign",
          databasePath: pending.location.databasePath,
        }),
      );
      const before = readPreservedData(pending.location.databasePath);

      expect(
        runtimeErrorCode(() =>
          resumeProjectRestoration({ cwd: fixture.cwd, home: fixture.home }, undefined, () => {
            called = true;
          }),
        ),
      ).toBe("PROJECT_ID_MISMATCH");

      expect(called).toBe(false);
      expect(readPreservedData(pending.location.databasePath)).toEqual(before);
      expect(existsSync(pending.publicationPath)).toBe(true);
    } finally {
      await fixture.dispose();
    }
  });

  test("неподдержанная схема staging отвергается без validator и публичного link", async () => {
    const fixture = new RuntimeFixture(group);
    let called = false;
    try {
      const pending = await createInterruptedPublication(fixture, "before-link");
      const staged = join(pending.stagingPath, "project.sqlite");
      // Намеренное повреждение технического заголовка, без подмены inode и marker ownership.
      const raw = new Database(staged, { create: false, readwrite: true });
      try {
        raw.exec("PRAGMA user_version=999999");
      } finally {
        raw.close();
      }
      const before = readFileSync(staged);

      expect(
        runtimeErrorCode(() =>
          resumeProjectRestoration({ cwd: fixture.cwd, home: fixture.home }, projectId, () => {
            called = true;
          }),
        ),
      ).toBe("SCHEMA_VERSION_UNSUPPORTED");

      expect(called).toBe(false);
      expect(readFileSync(staged)).toEqual(before);
      expect(existsSync(pending.location.databasePath)).toBe(false);
      expect(existsSync(pending.location.configPath)).toBe(false);
      expect(existsSync(pending.publicationPath)).toBe(true);
    } finally {
      await fixture.dispose();
    }
  });

  test("не закрытое WAL-соединение validator не допускает публикацию staging под вторым именем", async () => {
    const fixture = new RuntimeFixture(group);
    let leaked: ProjectDatabase | undefined;
    try {
      const pending = await createInterruptedPublication(fixture, "before-link");

      expect(
        runtimeErrorCode(() =>
          resumeProjectRestoration({ cwd: fixture.cwd, home: fixture.home }, projectId, (path) => {
            // Намеренно нарушен контракт callback: соединение закрывается только в finally теста.
            leaked = ProjectDatabase.open(path);
            leaked.get(projectId);
          }),
        ),
      ).toBe("RESTORE_DATABASE_OPEN");

      expect(existsSync(pending.location.databasePath)).toBe(false);
      expect(existsSync(pending.location.configPath)).toBe(false);
      expect(existsSync(pending.publicationPath)).toBe(true);
    } finally {
      leaked?.close();
      await fixture.dispose();
    }
  });

  test("поздний commit другого процесса и его outbox сохраняются после config failure и explicit resume", async () => {
    const fixture = new RuntimeFixture(group);
    try {
      const existingCwd = join(fixture.root, "existing-worktree");
      mkdirSync(existingCwd);
      writeFileSync(
        join(existingCwd, "relay.config.json"),
        JSON.stringify({ version: 1, projectId }),
      );
      const failed = await runNativeProcess({
        executable: process.execPath,
        args: [join(import.meta.dir, "restoration-late-writer-worker.ts")],
        cwd: fixture.cwd,
        env: {
          ...process.env,
          HOME: fixture.root,
          USERPROFILE: fixture.root,
          RELAY_TEST_CWD: fixture.cwd,
          RELAY_TEST_EXISTING_CWD: existingCwd,
          RELAY_TEST_HOME: fixture.home,
          RELAY_TEST_PROJECT: projectId,
          RELAY_TEST_PUBLICATION_FAILURE: "conflict",
        },
        timeoutMs: 10_000,
      });
      expect(failed.exitCode).toBe(0);
      expect(failed.stderr).toBe("");
      expect(JSON.parse(failed.stdout)).toMatchObject({ code: "RESTORE_RECOVERY_REQUIRED" });
      const pending = pendingPaths(fixture);
      const before = readPreservedData(pending.location.databasePath);
      const config = readFileSync(pending.location.configPath);
      let materializerCalled = false;
      expect(
        runtimeErrorCode(() =>
          restoreProject({ cwd: fixture.cwd, home: fixture.home }, projectId, () => {
            materializerCalled = true;
          }),
        ),
      ).toBe("RESTORE_RECOVERY_REQUIRED");
      expect(materializerCalled).toBe(false);

      const resumed = resumeProjectRestoration(
        { cwd: fixture.cwd, home: fixture.home },
        undefined,
        validatePreservedData,
      );

      expect(resumed).toEqual({
        location: pending.location,
        resumed: true,
        preservedExisting: true,
        sourceCheckpoint: null,
        recovery: null,
      });
      expect(before.project).toMatchObject({
        revision: 2,
        updatedBy: "late-writer",
        data: { name: "Принятая поздняя запись" },
      });
      expect(before.outbox).toHaveLength(2);
      expect(readPreservedData(pending.location.databasePath)).toEqual(before);
      expect(readFileSync(pending.location.configPath)).toEqual(config);
      expect(existsSync(pending.stagingPath)).toBe(false);
      expect(existsSync(pending.publicationPath)).toBe(false);
    } finally {
      await fixture.dispose();
    }
  });

  test.each(["before-link", "before-config", "after-config"] as const)(
    "авария %s завершается явным resume без нового snapshot",
    async (phase) => {
      const fixture = new RuntimeFixture(group);
      try {
        const pending = await createInterruptedPublication(fixture, phase);
        const source =
          phase === "before-link"
            ? join(pending.stagingPath, "project.sqlite")
            : pending.location.databasePath;
        const before = readPreservedData(source);
        const validated: string[] = [];

        const result = resumeProjectRestoration(
          { cwd: fixture.cwd, home: fixture.home },
          phase === "after-config" ? undefined : projectId,
          (path) => {
            validated.push(path);
            validatePreservedData(path);
          },
        );

        expect(validated).toEqual([source]);
        expect(result).toEqual({
          location: pending.location,
          resumed: true,
          preservedExisting: true,
          sourceCheckpoint: null,
          recovery: null,
        });
        expect(readPreservedData(pending.location.databasePath)).toEqual(before);
        const opened = openProject({ cwd: fixture.cwd, home: fixture.home });
        try {
          expect(opened.location).toEqual(pending.location);
        } finally {
          opened.database.close();
        }
        expect(existsSync(pending.publicationPath)).toBe(false);
      } finally {
        await fixture.dispose();
      }
    },
  );

  test("повтор после завершённой уборки даёт RESTORE_NOT_PENDING без validator и изменения данных", async () => {
    const fixture = new RuntimeFixture(group);
    let called = false;
    try {
      const pending = await createInterruptedPublication(fixture, "before-config");
      resumeProjectRestoration(
        { cwd: fixture.cwd, home: fixture.home },
        projectId,
        validatePreservedData,
      );
      const before = readPreservedData(pending.location.databasePath);

      expect(
        runtimeErrorCode(() =>
          resumeProjectRestoration({ cwd: fixture.cwd, home: fixture.home }, undefined, () => {
            called = true;
          }),
        ),
      ).toBe("RESTORE_NOT_PENDING");

      expect(called).toBe(false);
      expect(readPreservedData(pending.location.databasePath)).toEqual(before);
    } finally {
      await fixture.dispose();
    }
  });

  test("без config и явного ID не сканирует home и не создаёт файлы", async () => {
    const fixture = new RuntimeFixture(group);
    let called = false;
    try {
      expect(
        runtimeErrorCode(() =>
          resumeProjectRestoration({ cwd: fixture.cwd, home: fixture.home }, undefined, () => {
            called = true;
          }),
        ),
      ).toBe("RESTORE_PROJECT_ID_REQUIRED");

      expect(called).toBe(false);
      expect(existsSync(fixture.home)).toBe(false);
      expect(readdirSync(fixture.cwd)).toEqual([]);
    } finally {
      await fixture.dispose();
    }
  });

  test("чужой target даже того же projectId не принимается и не изменяется", async () => {
    const fixture = new RuntimeFixture(group);
    let called = false;
    try {
      const pending = await createInterruptedPublication(fixture, "before-config");
      rmSync(pending.location.databasePath);
      const foreign = ProjectDatabase.create(pending.location.databasePath, {
        id: projectId,
        name: "Чужая реплика",
        slug: "foreign",
      });
      foreign.close();
      const bytes = readFileSync(pending.location.databasePath);

      expect(
        runtimeErrorCode(() =>
          resumeProjectRestoration({ cwd: fixture.cwd, home: fixture.home }, projectId, () => {
            called = true;
          }),
        ),
      ).toBe("RESTORE_RECOVERY_REQUIRED");

      expect(called).toBe(false);
      expect(readFileSync(pending.location.databasePath)).toEqual(bytes);
      expect(existsSync(pending.location.configPath)).toBe(false);
      expect(existsSync(pending.publicationPath)).toBe(true);
      expect(existsSync(join(pending.stagingPath, "project.sqlite"))).toBe(
        process.platform === "win32",
      );
    } finally {
      await fixture.dispose();
    }
  });

  test.each(["malformed", "copied-marker", "legacy-without-identity"] as const)(
    "%s intent сохраняется без validator и публикации config",
    async (failure) => {
      const fixture = new RuntimeFixture(group);
      let called = false;
      try {
        const pending = await createInterruptedPublication(fixture, "before-config");
        const original = readFileSync(pending.publicationPath, "utf8");
        if (failure === "malformed") {
          writeFileSync(pending.publicationPath, "{broken");
        } else if (failure === "copied-marker") {
          rmSync(pending.publicationPath);
          writeFileSync(pending.publicationPath, original);
        } else {
          const value = JSON.parse(original);
          value.version = 1;
          delete value.databaseIdentity;
          writeFileSync(pending.publicationPath, JSON.stringify(value));
        }
        const marker = readFileSync(pending.publicationPath);
        const database = readFileSync(pending.location.databasePath);

        expect(
          runtimeErrorCode(() =>
            resumeProjectRestoration({ cwd: fixture.cwd, home: fixture.home }, projectId, () => {
              called = true;
            }),
          ),
        ).toBe("RESTORE_RECOVERY_REQUIRED");

        expect(called).toBe(false);
        expect(readFileSync(pending.publicationPath)).toEqual(marker);
        expect(readFileSync(pending.location.databasePath)).toEqual(database);
        expect(existsSync(pending.location.configPath)).toBe(false);
      } finally {
        await fixture.dispose();
      }
    },
  );

  test("чужой config не заменяется и новое место config не выбирается автоматически", async () => {
    const fixture = new RuntimeFixture(group);
    let called = false;
    try {
      const pending = await createInterruptedPublication(fixture, "before-config");
      const foreign = JSON.stringify({ version: 1, projectId: "foreign-project" });
      writeFileSync(pending.location.configPath, foreign);
      const bytes = readFileSync(pending.location.databasePath);

      expect(
        runtimeErrorCode(() =>
          resumeProjectRestoration({ cwd: fixture.cwd, home: fixture.home }, projectId, () => {
            called = true;
          }),
        ),
      ).toBe("PROJECT_ID_MISMATCH");
      expect(
        runtimeErrorCode(() =>
          resumeProjectRestoration(
            { cwd: fixture.cwd, home: fixture.home, config: "another.json" },
            projectId,
            () => {
              called = true;
            },
          ),
        ),
      ).toBe("RESTORE_RECOVERY_REQUIRED");

      expect(called).toBe(false);
      expect(readFileSync(pending.location.configPath, "utf8")).toBe(foreign);
      expect(readFileSync(pending.location.databasePath)).toEqual(bytes);
      expect(existsSync(join(fixture.cwd, "another.json"))).toBe(false);
      expect(existsSync(pending.publicationPath)).toBe(true);
    } finally {
      await fixture.dispose();
    }
  });

  test("живой writer staging запрещает восстановление второго имени до закрытия соединения", async () => {
    const fixture = new RuntimeFixture(group);
    let opened: ProjectDatabase | undefined;
    let called = false;
    try {
      const pending = await createInterruptedPublication(fixture, "before-link");
      opened = ProjectDatabase.open(join(pending.stagingPath, "project.sqlite"));
      opened.get(projectId);
      expect(existsSync(join(pending.stagingPath, "project.sqlite-wal"))).toBe(true);

      expect(
        runtimeErrorCode(() =>
          resumeProjectRestoration({ cwd: fixture.cwd, home: fixture.home }, projectId, () => {
            called = true;
          }),
        ),
      ).toBe("RESTORE_DATABASE_OPEN");

      expect(called).toBe(false);
      expect(existsSync(pending.location.databasePath)).toBe(false);
      expect(existsSync(pending.location.configPath)).toBe(false);
      opened.close();
      opened = undefined;
      expect(
        resumeProjectRestoration(
          { cwd: fixture.cwd, home: fixture.home },
          projectId,
          validatePreservedData,
        ).resumed,
      ).toBe(true);
    } finally {
      opened?.close();
      await fixture.dispose();
    }
  });

  test("при живом target WAL validator читает только публичное имя и сохраняет outbox", async () => {
    const fixture = new RuntimeFixture(group);
    let opened: ProjectDatabase | undefined;
    try {
      const pending = await createInterruptedPublication(fixture, "before-config");
      expect(existsSync(join(pending.stagingPath, "project.sqlite"))).toBe(
        process.platform === "win32",
      );
      opened = ProjectDatabase.open(pending.location.databasePath);
      const initial = opened.get(projectId);
      if (!initial) {
        throw new Error("Не найден проект fixture");
      }
      opened.update(
        {
          ...initial,
          revision: initial.revision + 1,
          updatedBy: "active-writer",
          data: { ...initial.data, name: "Живой WAL" },
        },
        initial.revision,
      );
      const outbox = opened.getReplicationOutbox();
      expect(existsSync(`${pending.location.databasePath}-wal`)).toBe(true);

      const resumed = resumeProjectRestoration(
        { cwd: fixture.cwd, home: fixture.home },
        projectId,
        (path) => {
          expect(path).toBe(pending.location.databasePath);
          expect(readPreservedData(path).project.data.name).toBe("Живой WAL");
          expect(existsSync(join(pending.stagingPath, "project.sqlite-wal"))).toBe(false);
        },
      );
      if (process.platform !== "win32" || resumed.recovery === null) {
        expect(resumed.recovery).toBeNull();
      } else {
        expect(["EPERM", "EACCES", "EBUSY"]).toContain(resumed.recovery.failure.code);
        expect(existsSync(pending.publicationPath)).toBe(true);
      }
      expect(opened.getReplicationOutbox()).toEqual(outbox);
      expect(opened.get(projectId)?.data.name).toBe("Живой WAL");
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(opened.getReplicationOutbox()).toEqual(outbox);
      const current = opened.get(projectId);
      if (!current) {
        throw new Error("Пропал проект после resume");
      }
      opened.update(
        {
          ...current,
          revision: current.revision + 1,
          data: { ...current.data, name: "После resume" },
        },
        current.revision,
      );
      expect(opened.get(projectId)?.data.name).toBe("После resume");
      expect(opened.getReplicationOutbox()).toHaveLength(outbox.length + 1);
      opened.close();
      opened = undefined;
      if (resumed.recovery) {
        expect(
          resumeProjectRestoration(
            { cwd: fixture.cwd, home: fixture.home },
            projectId,
            validatePreservedData,
          ).recovery,
        ).toBeNull();
      }
      expect(readPreservedData(pending.location.databasePath).project.data.name).toBe(
        "После resume",
      );
      expect(existsSync(pending.publicationPath)).toBe(false);
    } finally {
      opened?.close();
      await fixture.dispose();
    }
  });

  test("отказ validator сохраняет staging, intent и отсутствие публичного файла", async () => {
    const fixture = new RuntimeFixture(group);
    try {
      const pending = await createInterruptedPublication(fixture, "before-link");
      const bytes = readFileSync(join(pending.stagingPath, "project.sqlite"));

      expect(
        runtimeErrorCode(() =>
          resumeProjectRestoration({ cwd: fixture.cwd, home: fixture.home }, projectId, () => {
            throw new RelayError("INVALID_REPLICATION_STATE", "Неприемлемый снимок", 4);
          }),
        ),
      ).toBe("INVALID_REPLICATION_STATE");

      expect(readFileSync(join(pending.stagingPath, "project.sqlite"))).toEqual(bytes);
      expect(existsSync(pending.location.databasePath)).toBe(false);
      expect(existsSync(pending.location.configPath)).toBe(false);
      expect(existsSync(pending.publicationPath)).toBe(true);
    } finally {
      await fixture.dispose();
    }
  });

  test("async validator не вызывается; Promise обычного callback не разрешает публикацию", async () => {
    const fixture = new RuntimeFixture(group);
    let called = false;
    try {
      const pending = await createInterruptedPublication(fixture, "before-link");

      expect(
        runtimeErrorCode(() =>
          resumeProjectRestoration(
            { cwd: fixture.cwd, home: fixture.home },
            projectId,
            async () => {
              called = true;
            },
          ),
        ),
      ).toBe("INVALID_ARGUMENT");
      expect(called).toBe(false);
      expect(
        runtimeErrorCode(() =>
          resumeProjectRestoration({ cwd: fixture.cwd, home: fixture.home }, projectId, () =>
            Promise.resolve(),
          ),
        ),
      ).toBe("INVALID_ARGUMENT");

      expect(existsSync(pending.location.databasePath)).toBe(false);
      expect(existsSync(pending.location.configPath)).toBe(false);
      expect(existsSync(pending.publicationPath)).toBe(true);
    } finally {
      await fixture.dispose();
    }
  });

  test("неизвестный companion сохраняется с recovery-info после успешной привязки", async () => {
    const fixture = new RuntimeFixture(group);
    try {
      const pending = await createInterruptedPublication(fixture, "before-config");
      const extra = join(pending.stagingPath, "source-checkpoint.json");
      writeFileSync(extra, '{"external":"application-owned"}');

      const result = resumeProjectRestoration(
        { cwd: fixture.cwd, home: fixture.home },
        projectId,
        validatePreservedData,
      );
      const repeated = resumeProjectRestoration(
        { cwd: fixture.cwd, home: fixture.home },
        undefined,
        validatePreservedData,
      );

      expect(result).toEqual({
        location: pending.location,
        resumed: true,
        preservedExisting: true,
        sourceCheckpoint: null,
        recovery: {
          publicationPath: pending.publicationPath,
          stagingPath: pending.stagingPath,
          failure: { code: "RESTORE_CLEANUP_UNOWNED_FILES", message: expect.any(String) },
        },
      });
      expect(repeated).toEqual(result);
      expect(readFileSync(extra, "utf8")).toBe('{"external":"application-owned"}');
      expect(existsSync(pending.publicationPath)).toBe(true);
    } finally {
      await fixture.dispose();
    }
  });

  test("неизвестный hardlink staging не допускает чтение и публикацию нового имени", async () => {
    const fixture = new RuntimeFixture(group);
    let called = false;
    try {
      const pending = await createInterruptedPublication(fixture, "before-link");
      const alias = join(fixture.root, "unknown-alias.sqlite");
      linkSync(join(pending.stagingPath, "project.sqlite"), alias);

      expect(
        runtimeErrorCode(() =>
          resumeProjectRestoration({ cwd: fixture.cwd, home: fixture.home }, projectId, () => {
            called = true;
          }),
        ),
      ).toBe("RESTORE_RECOVERY_REQUIRED");

      expect(called).toBe(false);
      expect(existsSync(alias)).toBe(true);
      expect(existsSync(pending.location.databasePath)).toBe(false);
    } finally {
      await fixture.dispose();
    }
  });

  // POSIX permissions проверяются настоящей ФС; root/Windows не дают такой гарантии через chmod.
  test.skipIf(!process.getuid || process.getuid() === 0)(
    "отказ удаления private link не откатывает привязку и сохраняет причину cleanup",
    async () => {
      const fixture = new RuntimeFixture(group);
      let stagingPath: string | undefined;
      try {
        const pending = await createInterruptedPublication(fixture, "before-config");
        stagingPath = pending.stagingPath;
        const before = readPreservedData(pending.location.databasePath);
        chmodSync(stagingPath, 0o500);

        const result = resumeProjectRestoration(
          { cwd: fixture.cwd, home: fixture.home },
          projectId,
          validatePreservedData,
        );

        expect(result).toMatchObject({
          location: pending.location,
          resumed: true,
          preservedExisting: true,
          recovery: {
            stagingPath,
            publicationPath: pending.publicationPath,
            failure: { code: "EACCES", message: expect.any(String) },
          },
        });
        expect(readPreservedData(pending.location.databasePath)).toEqual(before);
        expect(existsSync(pending.location.configPath)).toBe(true);
        expect(existsSync(pending.publicationPath)).toBe(true);
        expect(existsSync(join(stagingPath, "publication.json"))).toBe(true);
      } finally {
        if (stagingPath && existsSync(stagingPath)) {
          chmodSync(stagingPath, 0o700);
        }
        await fixture.dispose();
      }
    },
  );
});
