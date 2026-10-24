import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { Database } from "bun:sqlite";
import { lstatSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ProjectDatabase } from "../../src/database/project-database";
import {
  ProjectDatabaseFixture,
  createDocument,
  expectRelayError,
} from "./helpers/project-database-fixture";
import type { ConcurrentOpenProcess, OpenProcessResult } from "./helpers/concurrent-open.types";
import { BatchReceiptUpgradeFixture } from "./helpers/batch-receipt-upgrade-fixture";
import { withWalBusyReplacement } from "./helpers/wal-retry-replacement";

/**
 * Запускает настоящий opener с stdin-barrier после imports; дедлайн ограничивает зависший child.
 * Вызывающий обязан дождаться result и завершить оставшийся процесс в finally.
 */
function startOpener(path: string): ConcurrentOpenProcess {
  const directory = dirname(path);
  const child = spawn(
    process.execPath,
    [join(import.meta.dir, "helpers/concurrent-open-worker.ts"), path],
    {
      cwd: directory,
      env: { ...process.env, HOME: directory, USERPROFILE: directory },
      stdio: "pipe",
      timeout: 5000,
    },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  const ready = new Promise<void>((resolve, reject) => {
    child.stdout.on("data", () => {
      if (stdout.startsWith("ready\n")) {
        resolve();
      }
    });
    child.once("error", reject);
    child.once("close", (code) =>
      reject(new Error(`Opener завершился до barrier: ${code}: ${stderr}`)),
    );
  });
  const result = new Promise<OpenProcessResult>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
  void result.catch(() => {});
  return { child, ready, result };
}

describe("Конкурентное первое открытие DELETE-базы", () => {
  test("три отдельных opener получают одну проверенную WAL-базу без лишнего outbox; readonly не меняет DELETE", async () => {
    const fixture = new ProjectDatabaseFixture("concurrent-open");
    const processes: ConcurrentOpenProcess[] = [];
    try {
      const initial = fixture.create();
      initial.insert(createDocument("DOC-OPEN"));
      const stat = lstatSync(fixture.path, { bigint: true });
      const expected = {
        path: fixture.path,
        projectId: initial.projectId,
        project: initial.get(initial.projectId),
        document: initial.get("DOC-OPEN"),
        generation: initial.getGeneration(),
        replicaId: initial.getReplicationState().replicaId,
        outbox: initial.getReplicationOutbox(),
        mode: { journal_mode: "wal" },
        physical: {
          device: String(stat.dev),
          inode: String(stat.ino),
          birthtimeNs: String(stat.birthtimeNs),
        },
      };
      initial.close();
      fixture.withRaw((raw) => raw.exec("PRAGMA journal_mode=DELETE"));
      const before = readFileSync(fixture.path);
      const reader = ProjectDatabase.openReadonly(fixture.path);
      try {
        expect(reader.get("DOC-OPEN")).toEqual(expected.document);
        expect(reader.getReplicationOutbox()).toEqual(expected.outbox);
      } finally {
        reader.close();
      }
      expect(readFileSync(fixture.path)).toEqual(before);
      fixture.withRaw((raw) =>
        expect(raw.query("PRAGMA journal_mode").get()).toEqual({ journal_mode: "delete" }),
      );
      for (let index = 0; index < 3; index += 1) {
        processes.push(startOpener(fixture.path));
      }
      await Promise.all(processes.map((process) => process.ready));

      for (const process of processes) {
        process.child.stdin.end("open\n");
      }
      const results = await Promise.all(processes.map((process) => process.result));

      for (const result of results) {
        expect(result).toMatchObject({ code: 0, signal: null, stderr: "" });
        expect(result.stdout.startsWith("ready\n")).toBe(true);
        const data: unknown = JSON.parse(result.stdout.slice("ready\n".length));
        expect(data).toEqual(expected);
      }
      const reopened = ProjectDatabase.openReadonly(fixture.path);
      try {
        expect(reopened.getReplicationOutbox()).toEqual(expected.outbox);
        expect(reopened.getGeneration()).toBe(expected.generation);
        expect(reopened.getReplicationState().replicaId).toBe(expected.replicaId);
      } finally {
        reopened.close();
      }
    } finally {
      for (const process of processes) {
        if (process.child.exitCode === null) {
          process.child.kill("SIGKILL");
        }
      }
      await Promise.allSettled(processes.map((process) => process.result));
      fixture.close();
    }
  });

  test("внешний DELETE-reader ограничивает открытие budget; отказ не возвращает DELETE как рабочую WAL-базу", async () => {
    const fixture = new ProjectDatabaseFixture("open-budget");
    let process: ConcurrentOpenProcess | undefined;
    let reader: Database | undefined;
    try {
      fixture.create().close();
      fixture.withRaw((raw) => raw.exec("PRAGMA journal_mode=DELETE"));
      const before = readFileSync(fixture.path);
      reader = new Database(fixture.path, { readonly: true });
      reader.exec("BEGIN; SELECT * FROM project_state");
      process = startOpener(fixture.path);
      await process.ready;

      process.child.stdin.end("open\n");
      const result = await process.result;

      expect(result).toMatchObject({ code: 4, signal: null, stderr: "" });
      const data: unknown = JSON.parse(result.stdout.slice("ready\n".length));
      expect(data).toMatchObject({ error: { code: "STORAGE_BUSY", exitCode: 4 } });
      expect(reader.query("PRAGMA journal_mode").get()).toEqual({ journal_mode: "delete" });
      reader.exec("ROLLBACK");
      reader.close();
      reader = undefined;
      expect(readFileSync(fixture.path)).toEqual(before);
      expect(fixture.open().projectId).toBe("project-id");
    } finally {
      if (process?.child.exitCode === null) {
        process.child.kill("SIGKILL");
      }
      if (process) {
        await Promise.allSettled([process.result]);
      }
      reader?.close();
      fixture.close();
    }
  });
});

describe("Повторная валидация после WAL BUSY", () => {
  test("после реального close повтор возвращает ID и данные новой совместимой БД", () => {
    const fixture = new ProjectDatabaseFixture("reopen-current");
    const replacement = new ProjectDatabaseFixture("replacement-current");
    let prepared: ProjectDatabase | undefined;
    try {
      fixture.create().close();
      fixture.withRaw((raw) => raw.exec("PRAGMA journal_mode=DELETE"));
      prepared = ProjectDatabase.create(replacement.path, {
        id: "replacement-project",
        name: "Новая выбранная база",
        slug: "replacement",
      });
      const document = {
        ...createDocument("DOC-REPLACEMENT"),
        data: { title: "Данные новой базы", content: "После закрытия первой попытки" },
      };
      prepared.insert(document);
      const expected = {
        projectId: "replacement-project",
        project: prepared.get("PROJECT"),
        document: prepared.get(document.id),
        replicaId: prepared.getReplicationState().replicaId,
        outbox: prepared.getReplicationOutbox(),
        generation: prepared.getGeneration(),
      };
      prepared.close();
      prepared = undefined;
      replacement.withRaw((raw) => raw.exec("PRAGMA journal_mode=DELETE"));

      const observed = withWalBusyReplacement(fixture.path, replacement.path, () => {
        const opened = ProjectDatabase.open(fixture.path);
        try {
          return {
            projectId: opened.projectId,
            project: opened.get("PROJECT"),
            document: opened.get(document.id),
            replicaId: opened.getReplicationState().replicaId,
            outbox: opened.getReplicationOutbox(),
            generation: opened.getGeneration(),
          };
        } finally {
          opened.close();
        }
      });

      expect(observed.trace).toEqual({
        walAttempts: 2,
        busyFailures: 1,
        firstCloses: 1,
        closedHandleRejectsQuery: true,
        reopens: 1,
        retryCloses: 1,
        events: [
          "wal-busy",
          "first-closed",
          "fixture-replaced",
          "reopened",
          "wal-retry",
          "retry-closed",
        ],
      });
      expect(observed.value).toEqual(expected);
      fixture.withRaw((raw) =>
        expect(raw.query("PRAGMA journal_mode").get()).toEqual({ journal_mode: "wal" }),
      );
    } finally {
      prepared?.close();
      replacement.close();
      fixture.close();
    }
  });

  test("старая схема на retry отклоняется без второй миграции и без изменения bytes или DDL", () => {
    const fixture = new ProjectDatabaseFixture("reopen-legacy");
    const replacement = new BatchReceiptUpgradeFixture();
    try {
      fixture.create().close();
      fixture.withRaw((raw) => raw.exec("PRAGMA journal_mode=DELETE"));
      replacement.createV1();
      replacement.withRaw((raw) => raw.exec("PRAGMA journal_mode=DELETE"));
      const beforeSchema = replacement.withRaw((raw) => ({
        version: raw.query("PRAGMA user_version").get(),
        definitions: raw
          .query("SELECT type, name, sql FROM sqlite_schema ORDER BY type, name")
          .all(),
      }));
      const beforeBytes = readFileSync(replacement.path);

      const observed = withWalBusyReplacement(fixture.path, replacement.path, () =>
        expectRelayError(() => {
          // При ошибочной реализации успешное соединение всё равно освобождается перед fail assertion.
          ProjectDatabase.open(fixture.path).close();
        }, "SCHEMA_VERSION_UNSUPPORTED"),
      );

      expect(observed.trace).toEqual({
        walAttempts: 1,
        busyFailures: 1,
        firstCloses: 1,
        closedHandleRejectsQuery: true,
        reopens: 1,
        retryCloses: 1,
        events: ["wal-busy", "first-closed", "fixture-replaced", "reopened", "retry-closed"],
      });
      expect(observed.value.details).toMatchObject({
        path: fixture.path,
        expectedVersion: 4,
        actualVersion: 1,
      });
      expect(readFileSync(fixture.path)).toEqual(beforeBytes);
      fixture.withRaw((raw) => {
        expect({
          version: raw.query("PRAGMA user_version").get(),
          definitions: raw
            .query("SELECT type, name, sql FROM sqlite_schema ORDER BY type, name")
            .all(),
        }).toEqual(beforeSchema);
        expect(raw.query("PRAGMA journal_mode").get()).toEqual({ journal_mode: "delete" });
      });
    } finally {
      replacement.close();
      fixture.close();
    }
  });
});
