import { describe, expect, test } from "bun:test";
import {
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { restoreProject, runNativeProcess, type ProcessResult } from "@relay/project-runtime";
import { RuntimeFixture, runtimeErrorCode } from "./helpers/runtime-fixture";
import { ProjectDatabase } from "@relay/storage";

const group = "git-sync-implementation/review-runtime/late-writer";
const projectId = "late-writer-project";

/**
 * Создаёт второй корректный config утраченной БД и запускает изолированный restore с barrier.
 * Child writer открывает опубликованную БД через этот config; процессы имеют deadline и не меняют env хоста.
 */
async function interruptAfterLateWrite(
  fixture: RuntimeFixture,
  mode: "conflict" | "crash",
): Promise<ProcessResult> {
  const existingCwd = join(fixture.root, "existing-worktree");
  mkdirSync(existingCwd);
  writeFileSync(join(existingCwd, "relay.config.json"), JSON.stringify({ version: 1, projectId }));
  return runNativeProcess({
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
      RELAY_TEST_PUBLICATION_FAILURE: mode,
    },
    timeoutMs: 10_000,
  });
}

/**
 * Проверяет принятую ревизию и recovery-материал через readonly-открытие публичного пути.
 */
function expectPreservedLateWrite(fixture: RuntimeFixture): void {
  const databasePath = join(fixture.home, "projects", projectId, "project.sqlite");
  // Readonly не включает WAL заново после явного закрытия журналов поздним writer.
  const database = ProjectDatabase.openReadonly(databasePath);
  try {
    expect(database.get(projectId)).toMatchObject({
      revision: 2,
      updatedBy: "late-writer",
      data: { name: "Принятая поздняя запись" },
    });
  } finally {
    database.close();
  }
  expect(existsSync(`${databasePath}-wal`)).toBe(false);
  expect(existsSync(`${databasePath}-journal`)).toBe(false);
  expect(Array.from(readFileSync(databasePath).subarray(18, 20))).toEqual([1, 1]);
  expect(existsSync(join(dirname(databasePath), ".restore-publication.json"))).toBe(true);
  expect(
    readdirSync(dirname(databasePath), { withFileTypes: true }).filter(
      (entry) => entry.isDirectory() && entry.name.startsWith(".restore-"),
    ),
  ).toHaveLength(1);
}

describe("Restore после принятой записи другого процесса", () => {
  test("проигрыш config сохраняет позднюю ревизию того же inode после завершения WAL", async () => {
    const fixture = new RuntimeFixture(group);
    try {
      const result = await interruptAfterLateWrite(fixture, "conflict");

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
      expect(JSON.parse(result.stdout)).toMatchObject({
        code: "RESTORE_RECOVERY_REQUIRED",
        details: {
          reason: "publication-failed",
          materializedInCurrentCall: true,
          location: {
            projectId,
            configPath: join(fixture.cwd, "relay.config.json"),
            databasePath: join(fixture.home, "projects", projectId, "project.sqlite"),
          },
          sourceError: { code: "CONFIG_EXISTS" },
        },
      });
      expectPreservedLateWrite(fixture);
      expect(JSON.parse(readFileSync(join(fixture.cwd, "relay.config.json"), "utf8"))).toEqual({
        version: 1,
        projectId,
        databasePath: join(fixture.home, "projects", projectId, "project.sqlite"),
      });
    } finally {
      await fixture.dispose();
    }
  });

  test("повтор после crash не удаляет принятую запись и не подменяет текущий fetched snapshot", async () => {
    const fixture = new RuntimeFixture(group);
    let materialized = false;
    try {
      const interrupted = await interruptAfterLateWrite(fixture, "crash");
      expect(interrupted).toEqual({ exitCode: 73, stdout: "", stderr: "" });
      expectPreservedLateWrite(fixture);

      expect(() =>
        restoreProject({ cwd: fixture.cwd, home: fixture.home }, projectId, () => {
          materialized = true;
          throw new Error("Нельзя выдавать прежнюю БД за snapshot нового запроса");
        }),
      ).toThrow(
        expect.objectContaining({
          code: "RESTORE_RECOVERY_REQUIRED",
          details: expect.objectContaining({
            reason: "pending-publication",
            materializedInCurrentCall: false,
          }),
        }),
      );

      expect(materialized).toBe(false);
      expectPreservedLateWrite(fixture);
      expect(existsSync(join(fixture.cwd, "relay.config.json"))).toBe(false);
    } finally {
      await fixture.dispose();
    }
  });

  test("legacy v2 с утраченным рабочим путём сохраняет staging с последней копией принятой записи", async () => {
    const fixture = new RuntimeFixture(group);
    const databasePath = join(fixture.home, "projects", projectId, "project.sqlite");
    let materialized = false;
    try {
      const interrupted = await interruptAfterLateWrite(fixture, "crash");
      expect(interrupted).toEqual({ exitCode: 73, stdout: "", stderr: "" });
      const staging = readdirSync(dirname(databasePath), { withFileTypes: true }).find(
        (entry) => entry.isDirectory() && entry.name.startsWith(".restore-"),
      );
      if (!staging) {
        throw new Error("Не найден staging после аварии");
      }
      const stagedDatabase = join(dirname(databasePath), staging.name, "project.sqlite");
      // Прежний v2 действительно оставлял alias: воспроизводим именно старый сохранённый intent.
      if (!existsSync(stagedDatabase)) {
        linkSync(databasePath, stagedDatabase);
      }
      const publicationPath = join(dirname(databasePath), ".restore-publication.json");
      const intent = JSON.parse(readFileSync(publicationPath, "utf8"));
      intent.version = 2;
      delete intent.transfer;
      writeFileSync(publicationPath, JSON.stringify(intent));
      const acceptedBytes = readFileSync(stagedDatabase);
      // Утрачен только рабочий путь: staging теперь единственная ссылка на БД с принятым commit.
      rmSync(databasePath);

      const code = runtimeErrorCode(() =>
        restoreProject({ cwd: fixture.cwd, home: fixture.home }, projectId, () => {
          materialized = true;
        }),
      );

      expect(code).toBe("RESTORE_RECOVERY_REQUIRED");
      expect(materialized).toBe(false);
      expect(readFileSync(stagedDatabase)).toEqual(acceptedBytes);
      expect(existsSync(databasePath)).toBe(false);
      const database = ProjectDatabase.open(stagedDatabase);
      try {
        expect(database.get(projectId)).toMatchObject({
          revision: 2,
          data: { name: "Принятая поздняя запись" },
        });
      } finally {
        database.close();
      }
      expect(existsSync(join(dirname(databasePath), ".restore-publication.json"))).toBe(true);
    } finally {
      await fixture.dispose();
    }
  });
});
