import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { RelayError } from "@relay/contracts";
import {
  ProjectDatabaseFixture,
  createDocument,
  expectRelayError,
} from "./helpers/project-database-fixture";

const transactionMethods = ["transaction", "snapshot"] as const;
const mixedTransactions = [
  { outer: "transaction", inner: "snapshot" },
  { outer: "snapshot", inner: "transaction" },
] as const;
let fixture: ProjectDatabaseFixture;

beforeEach(() => {
  fixture = new ProjectDatabaseFixture("transactions");
});

afterEach(() => {
  fixture.close();
});

describe("Атомарность транзакций и savepoint", () => {
  test("откат внешней транзакции возвращает записи, алиасы, поколение и счётчики", () => {
    const db = fixture.create();
    const generation = db.getGeneration();
    const entity = createDocument();
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
    const db = fixture.create();
    const first = createDocument("DOC-1");
    const rolledBack = createDocument("DOC-2");
    const last = createDocument("DOC-3");
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

  test.each(mixedTransactions)(
    "вложенный $inner внутри $outer откатывается независимо",
    ({ outer, inner }) => {
      const db = fixture.create();
      const kept = createDocument("DOC-1");
      const discarded = createDocument("DOC-2");
      const last = createDocument("DOC-3");
      const generation = db.getGeneration();

      const result = db[outer](() => {
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
      });

      expect(result).toBe("готово");
      expect(db.snapshot(() => db.list("document"))).toEqual([kept, last]);
      expect(db.getGeneration()).toBe(generation + 2);
    },
  );

  test("отказ внешнего snapshot отменяет вложенные записи и освобождает соединение", () => {
    const db = fixture.create();
    const generation = db.getGeneration();
    const failure = new RelayError("CANCELLED", "Отмена внешнего snapshot");
    let caught: unknown;

    try {
      db.snapshot(() => {
        db.transaction(() => {
          const key = db.nextKey("DOC");
          db.insert(createDocument(key));
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
});

describe("Согласованность WAL-снимков", () => {
  test("второе соединение читает подтверждённый снимок и получает ограниченный busy при записи", () => {
    const first = fixture.create();
    const second = fixture.open();
    const entity = createDocument();

    first.transaction(() => {
      first.insert(entity);
      expect(second.get(entity.id)).toBeUndefined();
      const busy = expectRelayError(() => second.insert(createDocument("DOC-2")), "STORAGE_BUSY");
      expect(busy.exitCode).toBe(4);
      expect(second.get("DOC-2")).toBeUndefined();
    });

    expect(second.get(entity.id)).toEqual(entity);
    second.insert(createDocument("DOC-2"));
    expect(first.list("document")).toHaveLength(2);
  });

  test("snapshot удерживает список и поколение после commit конкурентного писателя", () => {
    const reader = fixture.create();
    const entity = createDocument();
    reader.insert(entity);
    const generation = reader.getGeneration();
    fixture.withRaw((writer) => {
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
        // После commit писателя поколение читателя всё ещё должно соответствовать прочитанному списку.
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
    });
  });

  test("устаревший snapshot не повышается до записи и сохраняет исходный снимок после отказа", () => {
    const reader = fixture.create();
    const writer = fixture.open();
    const initial = createDocument();
    reader.insert(initial);
    const generation = reader.getGeneration();

    reader.snapshot(() => {
      expect(reader.list("document")).toEqual([initial]);
      writer.update({ ...initial, revision: 2, data: { title: "Конкурентная запись" } }, 1);
      expectRelayError(
        () => reader.transaction(() => reader.insert(createDocument("DOC-2"))),
        "STORAGE_BUSY",
      );
      expect(reader.list("document")).toEqual([initial]);
      expect(reader.getGeneration()).toBe(generation);
    });

    expect(reader.snapshot(() => reader.get(initial.id)?.revision)).toBe(2);
    expect(reader.get("DOC-2")).toBeUndefined();
    expect(reader.getGeneration()).toBe(generation + 1);
  });
});

describe("Синхронность и владение соединением", () => {
  test.each(transactionMethods)("%s отклоняет async callback до его запуска", (method) => {
    const db = fixture.create();
    let called = false;

    expectRelayError(() => {
      // @ts-expect-error Асинхронный callback запрещён также статической сигнатурой.
      db[method](async () => {
        called = true;
      });
    }, "ASYNC_TRANSACTION");

    expect(called).toBe(false);
    expect(db.list()).toHaveLength(3);
  });

  test.each(transactionMethods)(
    "%s откатывает возвращённый Promise и сохраняет соединение",
    (method) => {
      const db = fixture.create();
      const generation = db.getGeneration();

      expectRelayError(() => {
        // @ts-expect-error Синхронная функция не должна возвращать Promise.
        db[method](() => {
          db.insert(createDocument());
          return Promise.reject(new Error("Асинхронный результат недопустим"));
        });
      }, "ASYNC_TRANSACTION");

      expect(db.get("DOC-1")).toBeUndefined();
      expect(db.getGeneration()).toBe(generation);
      db.insert(createDocument());
      expect(db.list("document")).toHaveLength(1);
    },
  );

  test.each(transactionMethods)("закрытие идемпотентно, но запрещено внутри %s", (method) => {
    const db = fixture.create();

    expectRelayError(() => db[method](() => db.close()), "TRANSACTION_ACTIVE");

    expect(db.list()).toHaveLength(3);
    db.close();
    db.close();
    expectRelayError(() => db.get("PROJECT"), "DATABASE_CLOSED");
    expectRelayError(() => db[method](() => 42), "DATABASE_CLOSED");
  });
});
