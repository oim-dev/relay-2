import { describe, expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import * as files from "node:fs";
import {
  existsSync,
  linkSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { restoreProject, resumeProjectRestoration, runNativeProcess } from "@relay/project-runtime";
import { ProjectDatabase } from "@relay/storage";
import { RuntimeFixture, runtimeErrorCode } from "./helpers/runtime-fixture";
import { retainClosedFixtureShm } from "./helpers/restoration-sqlite";
import type {
  PendingRestorationFixture,
  PreservedRestorationData,
} from "./restoration-resume.test.types";

const group = "git-sync-implementation/finalization/macos-restore/second-ci-fix";
const projectId = "shm-project";

/**
 * Останавливает настоящий restore после intent либо public link; возвращает проверенные пути fixture.
 */
async function interruptedPublication(
  fixture: RuntimeFixture,
  phase: "before-link" | "before-config" = "before-link",
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
      RELAY_TEST_AFTER_CONFIG: "0",
      RELAY_TEST_REPLACE_ON_CONFIG_FAILURE: "0",
    },
    timeoutMs: 10_000,
  });
  expect(result).toEqual({ exitCode: 73, stdout: "", stderr: "" });
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
 * Снимает точное содержимое, replicaId и outbox через readonly snapshot без повторного включения WAL.
 */
function readPreservedState(path: string): PreservedRestorationData {
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

describe("Инертный private SHM после SQLite DELETE-barrier", () => {
  test("fresh restore убирает доказанный индекс до public link и сохраняет данные", async () => {
    const fixture = new RuntimeFixture(group);
    let expected: PreservedRestorationData | undefined;
    let stagedPath = "";
    try {
      const location = restoreProject(
        { cwd: fixture.cwd, home: fixture.home },
        projectId,
        (path) => {
          ProjectDatabase.create(path, {
            id: projectId,
            name: "Инертный SHM",
            slug: "shm",
          }).close();
          retainClosedFixtureShm(path);
          expected = readPreservedState(path);
          stagedPath = path;
          expect(existsSync(`${path}-shm`)).toBe(true);
        },
      );

      if (!expected) {
        throw new Error("Materializer fixture не сохранил исходное состояние");
      }
      expect(readPreservedState(location.databasePath)).toEqual(expected);
      expect(existsSync(`${location.databasePath}-wal`)).toBe(false);
      expect(existsSync(dirname(stagedPath))).toBe(false);
      expect(existsSync(join(dirname(location.databasePath), ".restore-publication.json"))).toBe(
        false,
      );
    } finally {
      await fixture.dispose();
    }
  });

  test("resume private staging с инертным SHM сохраняет replicaId/outbox и полностью завершает cleanup", async () => {
    const fixture = new RuntimeFixture(group);
    try {
      const pending = await interruptedPublication(fixture);
      const path = join(pending.stagingPath, "project.sqlite");
      retainClosedFixtureShm(path);
      const before = readPreservedState(path);

      const result = resumeProjectRestoration(
        { cwd: fixture.cwd, home: fixture.home },
        projectId,
        (validated) => {
          expect(validated).toBe(path);
          expect(readPreservedState(validated)).toEqual(before);
        },
      );

      expect(result.recovery).toBeNull();
      expect(readPreservedState(result.location.databasePath)).toEqual(before);
      expect(existsSync(pending.stagingPath)).toBe(false);
      expect(existsSync(pending.publicationPath)).toBe(false);
    } finally {
      await fixture.dispose();
    }
  });

  test("подменённый между sealing и barrier SHM сохраняется с отказом до validator", async () => {
    const fixture = new RuntimeFixture(group);
    let called = false;
    try {
      const pending = await interruptedPublication(fixture);
      const path = join(pending.stagingPath, "project.sqlite");
      retainClosedFixtureShm(path);
      const before = readPreservedState(path);
      const shmPath = `${path}-shm`;
      const close = Database.prototype.close;
      let replaced = false;
      const hook = spyOn(Database.prototype, "close").mockImplementation(function (
        this: Database,
        throwOnError,
      ) {
        close.call(this, throwOnError);
        if (this.filename === path && !replaced) {
          replaced = true;
          renameSync(shmPath, join(pending.stagingPath, "previous-shm"));
          writeFileSync(shmPath, "неизвестный новый файл", { flag: "wx" });
        }
      });
      try {
        expect(
          runtimeErrorCode(() =>
            resumeProjectRestoration({ cwd: fixture.cwd, home: fixture.home }, projectId, () => {
              called = true;
            }),
          ),
        ).toBe("RESTORE_RECOVERY_REQUIRED");
      } finally {
        hook.mockRestore();
      }

      expect(replaced).toBe(true);
      expect(called).toBe(false);
      expect(readFileSync(shmPath, "utf8")).toBe("неизвестный новый файл");
      expect(readPreservedState(path)).toEqual(before);
      expect(existsSync(pending.publicationPath)).toBe(true);
      expect(existsSync(pending.location.databasePath)).toBe(false);
    } finally {
      await fixture.dispose();
    }
  });

  test("SHM отсутствующего публичного target сохраняется и запрещает resume до validator", async () => {
    const fixture = new RuntimeFixture(group);
    let called = false;
    try {
      const pending = await interruptedPublication(fixture);
      const publicShm = `${pending.location.databasePath}-shm`;
      writeFileSync(publicShm, "индекс другого владельца");

      expect(
        runtimeErrorCode(() =>
          resumeProjectRestoration({ cwd: fixture.cwd, home: fixture.home }, projectId, () => {
            called = true;
          }),
        ),
      ).toBe("RESTORE_DATABASE_OPEN");

      expect(called).toBe(false);
      expect(readFileSync(publicShm, "utf8")).toBe("индекс другого владельца");
      expect(existsSync(pending.location.databasePath)).toBe(false);
      expect(existsSync(pending.publicationPath)).toBe(true);
    } finally {
      await fixture.dispose();
    }
  });

  test("подмена имени SHM между проверкой и изоляцией сохраняется без unlink чужого файла", async () => {
    const fixture = new RuntimeFixture(group);
    let called = false;
    try {
      const pending = await interruptedPublication(fixture);
      const path = join(pending.stagingPath, "project.sqlite");
      retainClosedFixtureShm(path);
      const before = readPreservedState(path);
      const shmPath = `${path}-shm`;
      const nativeRename = files.renameSync;
      let replaced = false;
      const hook = spyOn(files, "renameSync").mockImplementation((source, target) => {
        if (source === shmPath && !replaced) {
          replaced = true;
          nativeRename(shmPath, join(pending.stagingPath, "previous-shm"));
          writeFileSync(shmPath, "подмена непосредственно перед rename", { flag: "wx" });
        }
        nativeRename(source, target);
      });
      try {
        expect(() =>
          resumeProjectRestoration({ cwd: fixture.cwd, home: fixture.home }, projectId, () => {
            called = true;
          }),
        ).toThrow(
          expect.objectContaining({
            code: "RESTORE_RECOVERY_REQUIRED",
            details: expect.objectContaining({
              path: shmPath,
              reason: "staging-shm-changed",
              retainedPath: expect.any(String),
            }),
          }),
        );
      } finally {
        hook.mockRestore();
      }

      const retired = readdirSync(pending.stagingPath).find((name) =>
        name.startsWith(".restore-shm-"),
      );
      if (!retired) {
        throw new Error("Не сохранён изолированный неизвестный SHM");
      }
      expect(replaced).toBe(true);
      expect(called).toBe(false);
      expect(readFileSync(join(pending.stagingPath, retired, "index"), "utf8")).toBe(
        "подмена непосредственно перед rename",
      );
      expect(readPreservedState(path)).toEqual(before);
      expect(existsSync(pending.publicationPath)).toBe(true);
      expect(existsSync(pending.location.databasePath)).toBe(false);
    } finally {
      await fixture.dispose();
    }
  });

  test("новый private SHM при уже опубликованном target не выдаётся за разрешённый инертный индекс", async () => {
    const fixture = new RuntimeFixture(group);
    let called = false;
    try {
      const pending = await interruptedPublication(fixture, "before-config");
      const shm = join(pending.stagingPath, "project.sqlite-shm");
      const before = readPreservedState(pending.location.databasePath);
      writeFileSync(shm, "неизвестный private индекс");

      expect(
        runtimeErrorCode(() =>
          resumeProjectRestoration({ cwd: fixture.cwd, home: fixture.home }, projectId, () => {
            called = true;
          }),
        ),
      ).toBe("RESTORE_DATABASE_OPEN");

      expect(called).toBe(false);
      expect(readFileSync(shm, "utf8")).toBe("неизвестный private индекс");
      expect(readPreservedState(pending.location.databasePath)).toEqual(before);
      expect(existsSync(pending.publicationPath)).toBe(true);
    } finally {
      await fixture.dispose();
    }
  });

  test("fresh restore сохраняет staging и SHM с чужим hardlink вместо рекурсивной уборки", async () => {
    const fixture = new RuntimeFixture(group);
    const foreign = join(fixture.root, "foreign-shm");
    writeFileSync(foreign, "общий неизвестный индекс");
    let stagedPath = "";
    try {
      expect(
        runtimeErrorCode(() =>
          restoreProject({ cwd: fixture.cwd, home: fixture.home }, projectId, (path) => {
            ProjectDatabase.create(path, {
              id: projectId,
              name: "Не публиковать",
              slug: "shm",
            }).close();
            // Даже readonly-проверка WAL могла бы перезаписать чужой индекс: отказ нужен до открытия.
            if (existsSync(`${path}-shm`)) {
              renameSync(`${path}-shm`, join(dirname(path), "original-shm"));
            }
            linkSync(foreign, `${path}-shm`);
            stagedPath = path;
          }),
        ),
      ).toBe("RESTORE_RECOVERY_REQUIRED");

      expect(existsSync(stagedPath)).toBe(true);
      expect(readFileSync(`${stagedPath}-shm`, "utf8")).toBe("общий неизвестный индекс");
      expect(readFileSync(foreign, "utf8")).toBe("общий неизвестный индекс");
      expect(existsSync(join(fixture.cwd, "relay.config.json"))).toBe(false);
      expect(existsSync(join(fixture.home, "projects", projectId, "project.sqlite"))).toBe(false);
    } finally {
      await fixture.dispose();
    }
  });
});
