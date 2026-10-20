import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Worker } from "node:worker_threads";
import { RelayError, type EntityRecord } from "@relay/contracts";
import { ProjectDatabase } from "../../src";

const artifacts = resolve(
  import.meta.dir,
  "../../../..",
  ".artifacts",
  new Date().toISOString().slice(0, 10),
);
const metadata = { id: "project-id", name: "Тестовый проект", slug: "test-project" };
let directory: string;
let path: string;
let connections: ProjectDatabase[];

beforeEach(() => {
  mkdirSync(artifacts, { recursive: true });
  directory = mkdtempSync(join(artifacts, "storage-sqlite-"));
  path = join(directory, "project.sqlite");
  connections = [];
});

afterEach(() => {
  for (const db of connections.reverse()) db.close();
  rmSync(directory, { recursive: true, force: true });
});

function create(): ProjectDatabase {
  const db = ProjectDatabase.create(path, metadata);
  connections.push(db);
  return db;
}

function open(): ProjectDatabase {
  const db = ProjectDatabase.open(path);
  connections.push(db);
  return db;
}

function document(key = "DOC-1"): EntityRecord {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    kind: "document",
    key,
    revision: 1,
    createdAt: now,
    updatedAt: now,
    createdBy: "tester",
    updatedBy: "tester",
    data: { title: "Документ", content: "Текст" },
  };
}

function comment(body = "Комментарий"): Record<string, unknown> {
  return {
    id: crypto.randomUUID(),
    title: "Проверка",
    body,
    createdAt: new Date().toISOString(),
    createdBy: "reviewer",
  };
}

function expectCode(operation: () => unknown, code: string): RelayError {
  let caught: unknown;
  try {
    operation();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(RelayError);
  expect((caught as RelayError).code).toBe(code);
  return caught as RelayError;
}

describe("Файловая база проекта", () => {
  test("ключ не может перехватить синтаксис типизированной ссылки даже через примитивы Storage", () => {
    const db = create();
    const existing = document();
    db.insert(existing);
    const generation = db.getGeneration();
    expectCode(
      () => db.rename(existing.id, "document:DOC-OTHER", existing.revision, "tester"),
      "VALIDATION_ERROR",
    );
    expectCode(() => db.insert(document("document:DOC-1")), "CONFLICT");
    expectCode(() => db.update({ ...existing, key: "document:DOC-1", revision: 2 }, 1), "CONFLICT");
    expect(db.get(existing.id)).toEqual(existing);
    expect(db.getGeneration()).toBe(generation);
  });

  test("создаёт проект, пустой паспорт и доску; сохраняет схему и WAL после открытия", () => {
    const db = create();
    expect(db.path).toBe(path);
    expect(db.projectId).toBe(metadata.id);
    expect(db.get("PROJECT")).toMatchObject({
      id: metadata.id,
      kind: "project",
      revision: 1,
      createdBy: "system",
      updatedBy: "system",
      data: { name: metadata.name, slug: metadata.slug },
    });
    expect(db.get("PRODUCT")).toMatchObject({ kind: "product", revision: 1, data: {} });
    expect(db.get("BOARD-PRODUCT")).toMatchObject({
      kind: "board",
      data: { name: "Продукт", slug: "product", prefix: "PRODUCT" },
    });
    expect(db.list()).toHaveLength(3);
    const initial = db.list();
    const generation = db.getGeneration();
    const raw = new Database(path, { create: false, readwrite: true });
    try {
      expect(raw.query("PRAGMA journal_mode").get()).toEqual({ journal_mode: "wal" });
      expect(raw.query("PRAGMA user_version").get()).toEqual({ user_version: 1 });
      expect(raw.query("PRAGMA foreign_key_check").all()).toEqual([]);
      expect(raw.query("SELECT data FROM entities WHERE kind = 'project'").get()).toEqual({
        data: JSON.stringify({ name: metadata.name, slug: metadata.slug }),
      });
    } finally {
      raw.close();
    }
    db.close();
    const reopened = open();
    expect(reopened.projectId).toBe(metadata.id);
    expect(reopened.list()).toEqual(initial);
    expect(reopened.getGeneration()).toBe(generation);
  });

  test("не перезаписывает существующий файл и не создаёт отсутствующий при open", () => {
    expectCode(() => ProjectDatabase.open(path), "DATABASE_NOT_FOUND");
    expect(existsSync(path)).toBe(false);
    writeFileSync(path, "Данные, которые нельзя перезаписать");
    const before = readFileSync(path);
    expectCode(() => ProjectDatabase.create(path, metadata), "DATABASE_EXISTS");
    expect(readFileSync(path)).toEqual(before);
  });

  test("не инициализирует чужую базу и отклоняет неподдерживаемую версию", () => {
    writeFileSync(path, "");
    expectCode(() => ProjectDatabase.open(path), "DATABASE_INVALID");
    expect(readFileSync(path).length).toBe(0);
    rmSync(path);
    create().close();
    const raw = new Database(path, { create: false, readwrite: true });
    raw.exec("PRAGMA user_version = 999");
    raw.close();
    expectCode(() => ProjectDatabase.open(path), "SCHEMA_VERSION_UNSUPPORTED");
  });

  test("после неуспешной инициализации удаляет только созданную базу и допускает повтор", () => {
    expectCode(() => ProjectDatabase.create(path, { ...metadata, id: "PRODUCT" }), "CONFLICT");
    expect(existsSync(path)).toBe(false);
    expect(existsSync(`${path}-wal`)).toBe(false);
    expect(create().list()).toHaveLength(3);
  });

  test("откат внешней транзакции возвращает записи, алиасы, поколение и счётчики", () => {
    const db = create();
    const generation = db.getGeneration();
    const entity = document();
    const failure = new Error("Отмена операции");
    let caught: unknown;
    try {
      db.transaction(() => {
        expect(db.nextKey("DOC")).toBe("DOC-1");
        db.insert(entity);
        db.rename(entity.id, "DOC-OLD", 1, "renamer");
        throw failure;
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBe(failure);
    expect(db.get(entity.id)).toBeUndefined();
    expect(db.get("DOC-1")).toBeUndefined();
    expect(db.get("DOC-OLD")).toBeUndefined();
    expect(db.getGeneration()).toBe(generation);
    expect(db.nextKey("DOC")).toBe("DOC-1");
  });

  test("savepoint откатывается независимо, а внешняя транзакция продолжает запись", () => {
    const db = create();
    const first = document("DOC-1");
    const rolledBack = document("DOC-2");
    const last = document("DOC-3");
    const generation = db.getGeneration();
    const result = db.transaction(() => {
      db.insert(first);
      expect(() =>
        db.transaction(() => {
          db.insert(rolledBack);
          db.rename(first.id, "DOC-RENAMED", 1, "tester");
          throw new Error("Отмена вложенной операции");
        }),
      ).toThrow("Отмена вложенной операции");
      expect(db.get("DOC-RENAMED")).toBeUndefined();
      db.insert(last);
      return 42;
    });
    expect(result).toBe(42);
    expect(db.list("document")).toEqual([first, last]);
    expect(db.getGeneration()).toBe(generation + 2);
  });

  test("CAS сохраняет победившую запись и проверяется перед no-op rename", () => {
    const first = create();
    const second = open();
    const entity = document();
    first.insert(entity);
    const stale = second.get(entity.id)!;
    first.update({ ...entity, revision: 2, data: { title: "Первый редактор" } }, 1);
    const generation = first.getGeneration();
    const conflict = expectCode(
      () => second.update({ ...stale, revision: 2, data: { title: "Устаревший редактор" } }, 1),
      "REVISION_CONFLICT",
    );
    expect(conflict.exitCode).toBe(4);
    expect(conflict.details).toMatchObject({ expectedRevision: 1, actualRevision: 2 });
    expectCode(() => second.rename(entity.id, entity.key, 1, "tester"), "REVISION_CONFLICT");
    expect(second.get(entity.id)?.data).toEqual({ title: "Первый редактор" });
    expect(second.getGeneration()).toBe(generation);
  });

  test("сохраняет алиасы, не передаёт их другой сущности и разрешает вернуть прежний ключ", () => {
    const db = create();
    const entity = document();
    db.insert(entity);
    const renamed = db.rename(entity.id, "DOC-2", 1, "renamer");
    expect(renamed).toMatchObject({
      id: entity.id,
      key: "DOC-2",
      revision: 2,
      createdBy: "tester",
      updatedBy: "renamer",
    });
    expect(db.get("DOC-1")).toEqual(renamed);
    expect(db.get(entity.id)).toEqual(renamed);
    expect(db.get("DOC-1", "task")).toBeUndefined();
    expectCode(() => db.insert(document("DOC-1")), "CONFLICT");
    expectCode(() => db.insert({ ...document("OTHER"), id: "DOC-1" }), "CONFLICT");
    expectCode(() => db.insert(document(entity.id)), "CONFLICT");
    expect(db.nextKey("DOC")).toBe("DOC-3");
    const restored = db.rename(entity.id, "DOC-1", 2, "renamer");
    expect(db.get("DOC-2")).toEqual(restored);
    db.close();
    const reopened = open();
    expect(reopened.get("DOC-2")).toEqual(restored);
    expect(reopened.nextKey("DOC")).toBe("DOC-4");
  });

  test("не допускает изменения вида, авторства создания и пропуска ревизии", () => {
    const db = create();
    const entity = document();
    db.insert(entity);
    for (const patch of [
      { kind: "task" as const },
      { createdBy: "other" },
      { createdAt: "other" },
      { revision: 3 },
    ]) {
      expectCode(() => db.update({ ...entity, revision: 2, ...patch }, 1), "CONFLICT");
      expect(db.get(entity.id)).toEqual(entity);
    }
  });

  test("конфликт нового ключа не оставляет алиаса или новой ревизии", () => {
    const db = create();
    const first = document("DOC-1");
    const second = document("DOC-2");
    db.insert(first);
    db.insert(second);
    const generation = db.getGeneration();
    expectCode(() => db.rename(first.id, second.key, 1, "tester"), "CONFLICT");
    expect(db.get(first.id)).toEqual(first);
    expect(db.get(second.key)).toEqual(second);
    expect(db.getGeneration()).toBe(generation);
  });

  test("второе соединение читает подтверждённый снимок и получает ограниченный busy при записи", () => {
    const first = create();
    const second = open();
    const entity = document();
    first.transaction(() => {
      first.insert(entity);
      expect(second.get(entity.id)).toBeUndefined();
      const busy = expectCode(() => second.insert(document("DOC-2")), "STORAGE_BUSY");
      expect(busy.exitCode).toBe(4);
      expect(second.get("DOC-2")).toBeUndefined();
    });
    expect(second.get(entity.id)).toEqual(entity);
    second.insert(document("DOC-2"));
    expect(first.list("document")).toHaveLength(2);
  });

  test("snapshot читает committed состояние при активном писателе и удерживает list + generation после его commit", () => {
    const reader = create();
    const entity = document();
    reader.insert(entity);
    const generation = reader.getGeneration();
    const writer = new Database(path, { create: false, readwrite: true });
    try {
      writer.exec("BEGIN IMMEDIATE");
      writer
        .query(
          "UPDATE entities SET revision = revision + 1, data = json_set(data, '$.title', ?) WHERE id = ?",
        )
        .run("Новый заголовок", entity.id);
      const previous = reader.snapshot(() => {
        const list = reader.list("document");
        expect(list).toEqual([entity]);
        expect(reader.get(entity.id)).toEqual(entity);
        writer.exec("COMMIT");
        // Писатель уже подтвердил изменения, но поколение должно соответствовать прочитанному list.
        expect(reader.getGeneration()).toBe(generation);
        expect(reader.snapshot(() => reader.list("document"))).toEqual(list);
        return { list, generation: reader.getGeneration() };
      });
      expect(previous).toEqual({ list: [entity], generation });
      expect(
        reader.snapshot(() => ({
          list: reader.list("document"),
          generation: reader.getGeneration(),
        })),
      ).toEqual({
        list: [{ ...entity, revision: 2, data: { ...entity.data, title: "Новый заголовок" } }],
        generation: generation + 1,
      });
    } finally {
      if (writer.inTransaction) writer.exec("ROLLBACK");
      writer.close();
    }
  });

  test.each(["transaction", "snapshot"] as const)(
    "вложенный смешанный savepoint внутри %s откатывается независимо",
    (outer) => {
      const db = create();
      const inner = outer === "transaction" ? "snapshot" : "transaction";
      const kept = document("DOC-1");
      const discarded = document("DOC-2");
      const last = document("DOC-3");
      const generation = db.getGeneration();
      expect(
        db[outer](() => {
          db.insert(kept);
          expect(() =>
            db[inner](() => {
              db.insert(discarded);
              db.rename(kept.id, "DOC-RENAMED", 1, "editor");
              throw new Error("Отмена смешанного savepoint");
            }),
          ).toThrow("Отмена смешанного savepoint");
          expect(db.get("DOC-RENAMED")).toBeUndefined();
          expect(db.list("document")).toEqual([kept]);
          expect(db.getGeneration()).toBe(generation + 1);
          db.insert(last);
          return "готово";
        }),
      ).toBe("готово");
      expect(db.snapshot(() => db.list("document"))).toEqual([kept, last]);
      expect(db.getGeneration()).toBe(generation + 2);
    },
  );

  test("отказ внешнего snapshot отменяет завершённые вложенные записи и освобождает соединение", () => {
    const db = create();
    const generation = db.getGeneration();
    const failure = new RelayError("CANCELLED", "Отмена внешнего snapshot");
    let caught: unknown;
    try {
      db.snapshot(() => {
        db.transaction(() => {
          const key = db.nextKey("DOC");
          db.insert(document(key));
        });
        throw failure;
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBe(failure);
    expect(
      db.snapshot(() => ({ list: db.list("document"), generation: db.getGeneration() })),
    ).toEqual({ list: [], generation });
    expect(db.nextKey("DOC")).toBe("DOC-1");
  });

  test("устаревший snapshot не повышается до записи и сохраняет исходный снимок после отказа", () => {
    const reader = create();
    const writer = open();
    const initial = document();
    reader.insert(initial);
    const generation = reader.getGeneration();
    reader.snapshot(() => {
      expect(reader.list("document")).toEqual([initial]);
      writer.update({ ...initial, revision: 2, data: { title: "Конкурентная запись" } }, 1);
      expectCode(() => reader.transaction(() => reader.insert(document("DOC-2"))), "STORAGE_BUSY");
      expect(reader.list("document")).toEqual([initial]);
      expect(reader.getGeneration()).toBe(generation);
    });
    expect(reader.snapshot(() => reader.get(initial.id)?.revision)).toBe(2);
    expect(reader.get("DOC-2")).toBeUndefined();
    expect(reader.getGeneration()).toBe(generation + 1);
  });

  test.each(["transaction", "snapshot"] as const)(
    "%s не запускает async callback, откатывает возвращённый Promise и сохраняет соединение",
    (method) => {
      const db = create();
      let called = false;
      expectCode(() => {
        // @ts-expect-error Асинхронный callback запрещён также статической сигнатурой.
        db[method](async () => {
          called = true;
        });
      }, "ASYNC_TRANSACTION");
      expect(called).toBe(false);
      expectCode(() => {
        // @ts-expect-error Синхронная функция не должна возвращать Promise.
        db[method](() => {
          db.insert(document());
          return Promise.reject(new Error("Асинхронный результат недопустим"));
        });
      }, "ASYNC_TRANSACTION");
      expect(db.get("DOC-1")).toBeUndefined();
      db.insert(document());
      expect(db.list("document")).toHaveLength(1);
    },
  );

  test.each(["transaction", "snapshot"] as const)(
    "закрытие идемпотентно, но запрещено внутри %s",
    (method) => {
      const db = create();
      expectCode(() => db[method](() => db.close()), "TRANSACTION_ACTIVE");
      expect(db.list()).toHaveLength(3);
      db.close();
      db.close();
      expectCode(() => db.get("PROJECT"), "DATABASE_CLOSED");
      expectCode(() => db[method](() => 42), "DATABASE_CLOSED");
    },
  );

  test("комментарии проецируются из SQL, переживают CAS старого снимка содержания и повторное открытие", () => {
    const db = create();
    const task: EntityRecord = {
      ...document("TASK-1"),
      kind: "task",
      data: { title: "Обсуждение" },
    };
    db.insert(task);
    const stale = db.get(task.id)!;
    expect(stale.data.comments).toEqual([]);
    const generation = db.getGeneration();
    const first = comment("Первое сообщение");
    const appended = db.appendTaskComment(task.key, first);
    expect(appended).toEqual({ ...task, data: { ...task.data, comments: [first] } });
    expect(db.getGeneration()).toBe(generation + 1);
    const peer = open();
    const second = { ...comment("Второе сообщение"), createdAt: "2000-01-01T00:00:00.000Z" };
    peer.appendTaskComment(task.id, second);
    db.update(
      { ...stale, revision: 2, updatedBy: "editor", data: { ...stale.data, title: "Уточнение" } },
      1,
    );
    const updated = db.get(task.id)!;
    expect(updated.data).toEqual({ title: "Уточнение", comments: [first, second] });
    expect(db.list("task")).toEqual([updated]);
    expect(db.list().find((entity) => entity.id === task.id)).toEqual(updated);
    expect(db.getGeneration()).toBe(generation + 3);
    expectCode(() => peer.update({ ...stale, revision: 2 }, 1), "REVISION_CONFLICT");
    const raw = new Database(path, { create: false, readwrite: true });
    try {
      expect(raw.query("SELECT data FROM entities WHERE id = ?").get(task.id)).toEqual({
        data: JSON.stringify({ title: "Уточнение" }),
      });
      expect(
        raw.query("SELECT count(*) AS count FROM task_comments WHERE task_id = ?").get(task.id),
      ).toEqual({ count: 2 });
    } finally {
      raw.close();
    }
    db.rename(task.id, "TASK-RENAMED", 2, "editor");
    const third = comment("По прежнему ключу");
    const expected = db.appendTaskComment(task.key, third);
    expect(expected.revision).toBe(3);
    expect(expected.data.comments).toEqual([first, second, third]);
    peer.close();
    db.close();
    expect(open().get(task.key)).toEqual(expected);
  });

  test("откат комментариев возвращает журнал и поколение, включая перехваченный вложенный отказ", () => {
    const db = create();
    const task: EntityRecord = { ...document("TASK-1"), kind: "task" };
    db.insert(task);
    const initial = db.get(task.id)!;
    const generation = db.getGeneration();
    const first = comment();
    expect(() =>
      db.transaction(() => {
        db.appendTaskComment(task.id, first);
        throw new Error("Отмена комментария");
      }),
    ).toThrow("Отмена комментария");
    expect(db.get(task.id)).toEqual(initial);
    expect(db.getGeneration()).toBe(generation);
    const second = comment();
    db.transaction(() => {
      db.appendTaskComment(task.id, first);
      expect(() =>
        db.transaction(() => {
          db.appendTaskComment(task.id, second);
          throw new Error("Отмена вложенного комментария");
        }),
      ).toThrow("Отмена вложенного комментария");
    });
    expect(db.get(task.id)?.data.comments).toEqual([first]);
    expect(db.getGeneration()).toBe(generation + 1);
    expect(db.appendTaskComment(task.id, second).data.comments).toEqual([first, second]);
  });

  test("SQL защищает уникальность ID, вид задачи, FK и неизменяемость журнала; update не обходит CAS", () => {
    const db = create();
    const first: EntityRecord = { ...document("TASK-1"), kind: "task" };
    const second: EntityRecord = { ...document("TASK-2"), kind: "task" };
    db.insert(first);
    db.insert(second);
    const entry = comment();
    const appended = db.appendTaskComment(first.id, entry);
    const generation = db.getGeneration();
    expectCode(() => db.appendTaskComment(first.id, entry), "CONFLICT");
    expectCode(() => db.appendTaskComment(second.id, entry), "CONFLICT");
    expectCode(() => db.appendTaskComment("PRODUCT", comment()), "NOT_FOUND");
    expectCode(() => db.appendTaskComment("MISSING", comment()), "NOT_FOUND");
    expectCode(
      () => db.update({ ...appended, data: { ...appended.data, comments: [] } }, 1),
      "CONFLICT",
    );
    expect(db.getGeneration()).toBe(generation);
    const raw = new Database(path, { create: false, readwrite: true });
    try {
      raw.exec("PRAGMA foreign_keys = ON");
      expect(() =>
        raw.query("UPDATE task_comments SET body = 'Подмена' WHERE id = ?").run(entry.id as string),
      ).toThrow("append-only");
      expect(() =>
        raw.query("DELETE FROM task_comments WHERE id = ?").run(entry.id as string),
      ).toThrow("append-only");
      const insert = raw.query(
        "INSERT INTO task_comments(id, task_id, title, body, created_at, created_by) VALUES (?, ?, '', '', '', '')",
      );
      expect(() => insert.run(crypto.randomUUID(), db.get("PRODUCT")!.id)).toThrow("task");
      expect(() => insert.run(crypto.randomUUID(), "missing-task")).toThrow("FOREIGN KEY");
      expect(() =>
        raw
          .query(
            "UPDATE entities SET revision = revision + 1, data = json_set(data, '$.comments', json('[]')) WHERE id = ?",
          )
          .run(first.id),
      ).toThrow("CHECK");
    } finally {
      raw.close();
    }
    expect(db.get(first.id)).toEqual(appended);
    expect(db.getGeneration()).toBe(generation);
  });

  test("параллельные писатели получают разные номера и лишь один выигрывает CAS", async () => {
    const db = create();
    const generation = db.getGeneration();
    const workers = ["first", "second"].map(
      (actor) =>
        new Worker(new URL("./concurrent-writer.ts", import.meta.url), {
          workerData: { path, actor },
        }),
    );
    const readyResolvers: Array<() => void> = [];
    const ready = workers.map(
      () =>
        new Promise<void>((resolveReady) => {
          readyResolvers.push(resolveReady);
        }),
    );
    const results = workers.map(
      (worker, index) =>
        new Promise<{ keys: string[]; outcome: string }>((resolveResult, reject) => {
          worker.on("message", (message: { type: string; keys: string[]; outcome: string }) => {
            if (message.type === "ready") readyResolvers[index]!();
            else resolveResult(message);
          });
          worker.on("error", reject);
          worker.on("exit", (code) => {
            if (code !== 0) reject(new Error(`Писатель завершился с кодом ${code}`));
          });
        }),
    );
    const completed = Promise.all(results);
    let timeout: ReturnType<typeof setTimeout>;
    const deadline = new Promise<never>((_, reject) => {
      timeout = setTimeout(() => reject(new Error("Писатели не завершились за 4 секунды")), 4000);
    });
    try {
      await Promise.race([Promise.all(ready), completed, deadline]);
      for (const worker of workers) worker.postMessage("write");
      const written = await Promise.race([completed, deadline]);
      expect(new Set(written.flatMap((result) => result.keys)).size).toBe(12);
      expect(db.list("document")).toHaveLength(12);
      expect(db.nextKey("DOC")).toBe("DOC-13");
      expect(written.map((result) => result.outcome).sort()).toEqual([
        "REVISION_CONFLICT",
        "updated",
      ]);
      expect(db.get("PRODUCT")?.revision).toBe(2);
      expect(db.getGeneration()).toBe(generation + 13);
    } finally {
      clearTimeout(timeout!);
      await Promise.all(workers.map((worker) => worker.terminate()));
    }
  });
});
