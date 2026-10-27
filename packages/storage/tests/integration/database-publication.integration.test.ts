import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { Database, constants } from "bun:sqlite";
import { spawnSync } from "node:child_process";
import { existsSync, linkSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ProjectDatabase } from "../../src/database/project-database";
import { withProjectDatabasePublication } from "../../src/database/project-publication";
import { publishFixtureDatabase } from "./helpers/native/publication";
import {
  ProjectDatabaseFixture,
  createDocument,
  expectRelayError,
} from "./helpers/project-database-fixture";

let fixture: ProjectDatabaseFixture;

/**
 * Проверяет доступ к SQLite writer-lock отдельным коротким процессом с busy_timeout=0.
 * Его HOME/cwd изолированы, timeout завершает зависший probe; ошибки запуска не считаются занятостью БД.
 */
function expectPublicationWriterProbe(path: string, expected: "SQLITE_BUSY" | "ACQUIRED"): void {
  const directory = dirname(path);
  const probe = spawnSync(
    process.execPath,
    [join(import.meta.dir, "helpers/publication-lock-probe.ts"), path],
    {
      cwd: directory,
      env: { ...process.env, HOME: directory, USERPROFILE: directory },
      encoding: "utf8",
      timeout: 5000,
    },
  );
  expect(probe.error).toBeUndefined();
  expect({
    status: probe.status,
    signal: probe.signal,
    stdout: probe.stdout,
    stderr: probe.stderr,
  }).toEqual({
    status: 0,
    signal: null,
    stdout: `${expected}\n`,
    stderr: "",
  });
}

beforeEach(() => {
  fixture = new ProjectDatabaseFixture("publication");
});

afterEach(() => {
  fixture.close();
});

describe("SQLite-барьер публикации private БД", () => {
  test("публикация выбранным для платформы способом сохраняет kernel lock и данные", () => {
    const database = fixture.create();
    const initial = database.list();
    database.close();
    const target = join(fixture.directory, "published.sqlite");

    withProjectDatabasePublication(fixture.path, () => {
      publishFixtureDatabase(fixture.path, target);
      expectPublicationWriterProbe(target, "SQLITE_BUSY");
    });

    expectPublicationWriterProbe(target, "ACQUIRED");
    expect(existsSync(fixture.path)).toBe(process.platform === "win32");
    const published = ProjectDatabase.openReadonly(target);
    try {
      expect(published.list()).toEqual(initial);
    } finally {
      published.close();
    }
  });

  test("закрытый persistent WAL публикуется целиком; публичный writer ждёт освобождения SQLite-lock", () => {
    const database = fixture.create();
    const document = createDocument();
    database.insert(document);
    const outbox = database.getReplicationOutbox();
    const replicaId = database.getReplicationState().replicaId;
    const raw = new Database(fixture.path, { create: false, readwrite: true });
    try {
      // Настоящий SQLite-режим, оставляющий companions после close, в том числе на Linux.
      expect(raw.fileControl(constants.SQLITE_FCNTL_PERSIST_WAL, new Int32Array([1, 0]))).toBe(0);
      raw.query("SELECT * FROM project_state").get();
      database.close();
    } finally {
      raw.close(true);
    }
    expect(existsSync(`${fixture.path}-wal`)).toBe(true);
    expect(existsSync(`${fixture.path}-shm`)).toBe(true);
    const target = join(fixture.directory, "published.sqlite");

    withProjectDatabasePublication(fixture.path, () => {
      expect(existsSync(`${fixture.path}-wal`)).toBe(false);
      expect(existsSync(`${fixture.path}-journal`)).toBe(false);
      linkSync(fixture.path, target);
      // Внутрипроцессный VFS-cache не доказывает удержание kernel fcntl-lock.
      expectPublicationWriterProbe(target, "SQLITE_BUSY");
    });

    expectPublicationWriterProbe(target, "ACQUIRED");
    // Чтение закрывает отдельный FD datafile: на POSIX это сняло бы fcntl-lock внутри barrier.
    // Здесь barrier уже освобождён, а ProjectDatabase.open ещё не включил WAL снова.
    expect(Array.from(readFileSync(fixture.path).subarray(18, 20))).toEqual([1, 1]);
    const published = ProjectDatabase.open(target);
    try {
      expect(published.get(document.id)).toEqual(document);
      expect(published.getReplicationOutbox()).toEqual(outbox);
      expect(published.getReplicationState().replicaId).toBe(replicaId);
      const later = createDocument("DOC-LATE");
      published.insert(later);
      expect(published.get(later.id)).toEqual(later);
    } finally {
      published.close();
    }
  });

  test("живой WAL не публикуется и продолжает принимать записи после отказа", () => {
    const writer = fixture.create();
    const before = writer.getReplicationOutbox();
    let called = false;

    expectRelayError(
      () =>
        withProjectDatabasePublication(fixture.path, () => {
          called = true;
        }),
      "DATABASE_PUBLICATION_BUSY",
    );

    expect(called).toBe(false);
    expect(writer.getReplicationOutbox()).toEqual(before);
    const document = createDocument();
    writer.insert(document);
    expect(writer.get(document.id)).toEqual(document);
  });

  test("writer между закрытием DELETE и повторной блокировкой запрещает публикацию без потери commit", () => {
    fixture.create().close();
    const document = createDocument("DOC-RACE");
    const close = Database.prototype.close;
    let writer: ProjectDatabase | undefined;
    let injected = false;
    let called = false;
    const hook = spyOn(Database.prototype, "close").mockImplementation(function (
      this: Database,
      throwOnError,
    ) {
      close.call(this, throwOnError);
      if (this.filename === fixture.path && !injected) {
        injected = true;
        writer = fixture.open();
        writer.insert(document);
      }
    });
    try {
      expectRelayError(
        () =>
          withProjectDatabasePublication(fixture.path, () => {
            called = true;
          }),
        "DATABASE_PUBLICATION_BUSY",
      );

      expect(injected).toBe(true);
      expect(called).toBe(false);
      expect(writer?.get(document.id)).toEqual(document);
      expect(existsSync(`${fixture.path}-wal`)).toBe(true);
    } finally {
      hook.mockRestore();
    }
  });

  test("ошибка после hardlink сохраняет опубликованный файл и освобождает SQLite-lock", () => {
    const database = fixture.create();
    const initial = database.list();
    database.close();
    const target = join(fixture.directory, "published.sqlite");
    const failure = new Error("Отказ после публикации");

    expect(() =>
      withProjectDatabasePublication(fixture.path, () => {
        linkSync(fixture.path, target);
        throw failure;
      }),
    ).toThrow(failure);

    const published = ProjectDatabase.openReadonly(target);
    try {
      expect(published.list()).toEqual(initial);
    } finally {
      published.close();
    }
  });

  test("Promise после hardlink отклоняется без удаления опубликованной БД", () => {
    const database = fixture.create();
    const initial = database.list();
    const outbox = database.getReplicationOutbox();
    database.close();
    const target = join(fixture.directory, "published.sqlite");

    expectRelayError(
      () =>
        withProjectDatabasePublication(fixture.path, () => {
          linkSync(fixture.path, target);
          return Promise.resolve();
        }),
      "INVALID_ARGUMENT",
    );

    const published = ProjectDatabase.openReadonly(target);
    try {
      expect(published.list()).toEqual(initial);
      expect(published.getReplicationOutbox()).toEqual(outbox);
      expect(existsSync(fixture.path)).toBe(true);
    } finally {
      published.close();
    }
  });
});

describe("Readonly-проверка сохранённой БД", () => {
  test("читает актуальный живой WAL и запрещает запись без изменения outbox", () => {
    const writer = fixture.create();
    const document = createDocument();
    writer.insert(document);
    const before = writer.getReplicationOutbox();
    const reader = ProjectDatabase.openReadonly(fixture.path);
    try {
      expect(reader.snapshot(() => reader.get(document.id))).toEqual(document);
      const error = expectRelayError(
        () => reader.insert(createDocument("DOC-FORBIDDEN")),
        "STORAGE_ERROR",
      );
      expect(error.cause).toMatchObject({ code: "SQLITE_READONLY" });
      expect(writer.getReplicationOutbox()).toEqual(before);
      expect(writer.get("DOC-FORBIDDEN")).toBeUndefined();
    } finally {
      reader.close();
    }
  });

  test("проверка DELETE-базы не включает WAL и не переписывает datafile", () => {
    fixture.create().close();
    withProjectDatabasePublication(fixture.path, () => {});
    const before = readFileSync(fixture.path);
    // На macOS SQLite может сохранить инертный индекс после WAL→DELETE. Readonly не меняет его.
    const shmBefore = existsSync(`${fixture.path}-shm`)
      ? readFileSync(`${fixture.path}-shm`)
      : null;
    const reader = ProjectDatabase.openReadonly(fixture.path);
    try {
      expect(reader.snapshot(() => reader.list())).toHaveLength(3);
    } finally {
      reader.close();
    }

    expect(readFileSync(fixture.path)).toEqual(before);
    expect(existsSync(`${fixture.path}-wal`)).toBe(false);
    expect(existsSync(`${fixture.path}-journal`)).toBe(false);
    expect(existsSync(`${fixture.path}-shm`) ? readFileSync(`${fixture.path}-shm`) : null).toEqual(
      shmBefore,
    );
  });

  test("предыдущая схема отвергается без автоматической миграции", () => {
    fixture.create().close();
    withProjectDatabasePublication(fixture.path, () => {});
    fixture.withRaw((raw) => raw.exec("PRAGMA user_version=3"));
    const before = readFileSync(fixture.path);

    expectRelayError(
      () => ProjectDatabase.openReadonly(fixture.path),
      "SCHEMA_VERSION_UNSUPPORTED",
    );

    expect(readFileSync(fixture.path)).toEqual(before);
    fixture.withRaw((raw) =>
      expect(raw.query("PRAGMA user_version").get()).toEqual({ user_version: 3 }),
    );
  });
});
