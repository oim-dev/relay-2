import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import * as files from "node:fs";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { RelayError } from "@relay/contracts";
import { ProjectDatabase } from "@relay/storage";
import {
  initializeProject,
  restoreProject,
  resumeProjectRestoration,
  type ProjectLocation,
} from "@relay/project-runtime";
import { RuntimeFixture, runtimeErrorCode } from "./helpers/runtime-fixture";

let fixture: RuntimeFixture;

/**
 * Создаёт закрытую fixture-БД для нового restore.
 */
function materialize(path: string): void {
  ProjectDatabase.create(path, { id: "restored", name: "Публикация", slug: "restored" }).close();
}

/**
 * Проверяет WAL до любого healing-open, затем первое обычное чтение при чужом writer-lock.
 * Все соединения и незавершённая транзакция закрываются при любом исходе утверждений.
 */
function expectPublishedWal(location: ProjectLocation): void {
  const raw = new Database(location.databasePath, { create: false, readwrite: true });
  try {
    expect(raw.query("PRAGMA journal_mode").get()).toEqual({ journal_mode: "wal" });
    raw.exec("BEGIN IMMEDIATE");
    const reader = ProjectDatabase.open(location.databasePath);
    try {
      expect(reader.get("PROJECT")?.id).toBe(location.projectId);
    } finally {
      reader.close();
    }
  } finally {
    if (raw.inTransaction) {
      raw.exec("ROLLBACK");
    }
    raw.close();
  }
}

beforeEach(() => {
  fixture = new RuntimeFixture("home-storage/published-wal");
});
afterEach(async () => {
  await fixture.dispose();
});

describe("Рабочий WAL после безопасной публикации", () => {
  test.each([
    { name: "init", init: true },
    { name: "restore", init: false },
  ])("$name готов к первому чтению под чужим writer-lock", ({ init }) => {
    const options = { cwd: fixture.cwd, home: fixture.home };

    const location = init
      ? initializeProject(options)
      : restoreProject(options, "restored", materialize);

    expectPublishedWal(location);
  });

  test("resume завершает сохранённую публикацию в WAL", () => {
    const options = { cwd: fixture.cwd, home: fixture.home };
    const configPath = join(fixture.cwd, "relay.config.json");
    const link = files.linkSync;
    const hook = spyOn(files, "linkSync").mockImplementation((source, target) => {
      if (target === configPath) {
        throw new RelayError("IO_ERROR", "fixture: отказ публикации config", 4);
      }
      link(source, target);
    });
    try {
      expect(runtimeErrorCode(() => restoreProject(options, "restored", materialize))).toBe(
        "RESTORE_RECOVERY_REQUIRED",
      );
    } finally {
      hook.mockRestore();
    }

    const result = resumeProjectRestoration(options, "restored", () => {});

    expect(result.recovery).toBeNull();
    expectPublishedWal(result.location);
  });

  test("отказ подготовки public WAL оставляет intent и допускает resume, не публикуя config", () => {
    const options = { cwd: fixture.cwd, home: fixture.home };
    const target = join(fixture.home, "projects", "restored", "project.sqlite");
    const open = ProjectDatabase.open;
    const hook = spyOn(ProjectDatabase, "open").mockImplementation((path) => {
      if (path === target) {
        throw new RelayError("STORAGE_BUSY", "fixture: public WAL busy", 4);
      }
      return open(path);
    });
    try {
      expect(() => restoreProject(options, "restored", materialize)).toThrow(
        expect.objectContaining({
          code: "RESTORE_RECOVERY_REQUIRED",
          details: expect.objectContaining({
            sourceError: expect.objectContaining({ code: "STORAGE_BUSY" }),
          }),
        }),
      );
    } finally {
      hook.mockRestore();
    }
    const intent = JSON.parse(
      readFileSync(join(fixture.home, "projects", "restored", ".restore-publication.json"), "utf8"),
    );
    expect(existsSync(join(fixture.cwd, "relay.config.json"))).toBe(false);

    const resumed = resumeProjectRestoration(options, "restored", () => {});

    expect(resumed.location.databasePath).toBe(intent.databasePath);
    expect(resumed.recovery).toBeNull();
    expectPublishedWal(resumed.location);
  });
});
