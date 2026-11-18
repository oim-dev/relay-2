import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  ProjectDatabaseFixture,
  createComment,
  createTask,
  expectRelayError,
  requireRecord,
} from "./helpers/project-database-fixture";

const sqlConstraints = [
  {
    name: "изменение опубликованного комментария",
    sql: "UPDATE task_comments SET body = 'Подмена' WHERE id = ?",
    target: "comment",
    expectedCode: "SQLITE_CONSTRAINT_TRIGGER",
  },
  {
    name: "удаление опубликованного комментария",
    sql: "DELETE FROM task_comments WHERE id = ?",
    target: "comment",
    expectedCode: "SQLITE_CONSTRAINT_TRIGGER",
  },
  {
    name: "комментарий к сущности другого вида",
    sql: "INSERT INTO task_comments(id, task_id, title, body, created_at, created_by) VALUES ('new-comment', ?, '', '', '', '')",
    target: "product",
    expectedCode: "SQLITE_CONSTRAINT_FOREIGNKEY",
  },
  {
    name: "комментарий к отсутствующей задаче",
    sql: "INSERT INTO task_comments(id, task_id, title, body, created_at, created_by) VALUES ('new-comment', ?, '', '', '', '')",
    target: "missing",
    expectedCode: "SQLITE_CONSTRAINT_FOREIGNKEY",
  },
] as const;
const duplicateTargets = [
  { name: "той же задачи", target: "first" },
  { name: "другой задачи", target: "second" },
] as const;
const missingTargets = [
  { name: "другой вид владельца", ref: "PRODUCT" },
  { name: "отсутствующий владелец", ref: "MISSING" },
] as const;
let fixture: ProjectDatabaseFixture;

beforeEach(() => {
  fixture = new ProjectDatabaseFixture("comments");
});

afterEach(() => {
  fixture.close();
});

describe("Независимый append-only журнал задачи", () => {
  test("комментарии переживают CAS старого содержания, переименование и повторное открытие", () => {
    const db = fixture.create();
    const task = createTask(db, "TASK-1", { title: "Обсуждение" });
    db.insert(task);
    const stale = requireRecord(db, task.id);
    expect(stale.data.comments).toEqual([]);
    const generation = db.getGeneration();
    const first = createComment("Первое сообщение");

    const appended = db.appendTaskComment(task.key, first);

    expect(appended).toEqual({ ...task, data: { ...task.data, comments: [first] } });
    expect(db.getGeneration()).toBe(generation + 1);
    const peer = fixture.open();
    // Порядок публикаций определяется sequence, а не временем чужого компьютера.
    const second = { ...createComment("Второе сообщение"), createdAt: "2000-01-01T00:00:00.000Z" };
    peer.appendTaskComment(task.id, second);
    const decoder = spyOn(JSON, "parse");
    const queries = spyOn(Database.prototype, "query");
    try {
      db.update(
        { ...stale, revision: 2, updatedBy: "editor", data: { ...stale.data, title: "Уточнение" } },
        1,
      );

      // Outbox декодирует только before/after затронутой карточки; независимый журнал не читается.
      expect(
        decoder.mock.calls.every(
          ([json]) => !json.includes(first.body) && !json.includes(second.body),
        ),
      ).toBe(true);
      expect(queries).toHaveBeenCalled();
      expect(queries.mock.calls.some(([sql]) => /\bFROM task_comments\b/i.test(sql))).toBe(false);
    } finally {
      queries.mockRestore();
      decoder.mockRestore();
    }
    const updated = requireRecord(db, task.id);
    expect(updated.data).toEqual({ ...task.data, title: "Уточнение", comments: [first, second] });
    expect(db.list("task")).toEqual([updated]);
    expect(db.list().find((entity) => entity.id === task.id)).toEqual(updated);
    expect(db.getGeneration()).toBe(generation + 3);
    expectRelayError(() => peer.update({ ...stale, revision: 2 }, 1), "REVISION_CONFLICT");
    fixture.withRaw((raw) => {
      expect(raw.query("SELECT title FROM tasks WHERE id = ?").get(task.id)).toEqual({
        title: "Уточнение",
      });
      expect(
        raw.query("SELECT count(*) AS count FROM task_comments WHERE task_id = ?").get(task.id),
      ).toEqual({ count: 2 });
    });
    const renamed = db.rename(task.id, "TASK-RENAMED", 2, "editor");
    expect(renamed.data).toEqual({ ...task.data, title: "Уточнение", comments: [first, second] });
    expect(db.get(task.id)).toEqual(renamed);
    const generationAfterRename = db.getGeneration();
    expect(db.rename(task.id, renamed.key, 3, "other-editor")).toEqual(renamed);
    expect(db.getGeneration()).toBe(generationAfterRename);
    const third = createComment("По прежнему ключу");
    const expected = db.appendTaskComment(task.key, third);
    expect(expected.revision).toBe(3);
    expect(expected.data.comments).toEqual([first, second, third]);
    peer.close();
    db.close();
    expect(fixture.open().get(task.key)).toEqual(expected);
  });

  test("откат внешней транзакции возвращает журнал и поколение", () => {
    const db = fixture.create();
    const task = createTask(db);
    db.insert(task);
    const initial = requireRecord(db, task.id);
    const generation = db.getGeneration();
    const entry = createComment();

    expect(() =>
      db.transaction(() => {
        db.appendTaskComment(task.id, entry);
        throw new Error("Отмена комментария");
      }),
    ).toThrow("Отмена комментария");

    expect(db.get(task.id)).toEqual(initial);
    expect(db.getGeneration()).toBe(generation);
  });

  test("перехваченный вложенный отказ откатывает только свой комментарий и освобождает его ID", () => {
    const db = fixture.create();
    const task = createTask(db);
    db.insert(task);
    const generation = db.getGeneration();
    const first = createComment();
    const second = createComment();

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

  test.each(duplicateTargets)(
    "повтор ID комментария $name отклоняется без изменения журнала",
    ({ target }) => {
      const db = fixture.create();
      const first = createTask(db, "TASK-1");
      const second = createTask(db, "TASK-2");
      db.insert(first);
      db.insert(second);
      const entry = createComment();
      const appended = db.appendTaskComment(first.id, entry);
      const generation = db.getGeneration();
      const tasks = { first, second };

      expectRelayError(() => db.appendTaskComment(tasks[target].id, entry), "CONFLICT");

      expect(db.get(first.id)).toEqual(appended);
      expect(db.get(second.id)).toEqual({ ...second, data: { ...second.data, comments: [] } });
      expect(db.getGeneration()).toBe(generation);
    },
  );

  test.each(missingTargets)("$name даёт NOT_FOUND без публикации комментария", ({ ref }) => {
    const db = fixture.create();
    const initial = db.list();
    const generation = db.getGeneration();

    expectRelayError(() => db.appendTaskComment(ref, createComment()), "NOT_FOUND");

    expect(db.list()).toEqual(initial);
    expect(db.getGeneration()).toBe(generation);
  });

  test("замена проекции журнала через update без следующей ревизии отклоняется", () => {
    const db = fixture.create();
    const task = createTask(db);
    db.insert(task);
    const appended = db.appendTaskComment(task.id, createComment());
    const generation = db.getGeneration();

    expectRelayError(
      () => db.update({ ...appended, data: { ...appended.data, comments: [] } }, 1),
      "CONFLICT",
    );

    expect(db.get(task.id)).toEqual(appended);
    expect(db.getGeneration()).toBe(generation);
  });

  test.each(sqlConstraints)(
    "SQL запрещает $name без изменения журнала и поколения",
    ({ sql, target, expectedCode }) => {
      const db = fixture.create();
      const task = createTask(db);
      db.insert(task);
      const entry = createComment();
      const appended = db.appendTaskComment(task.id, entry);
      const generation = db.getGeneration();
      const targets = {
        comment: entry.id,
        task: task.id,
        product: requireRecord(db, "PRODUCT").id,
        missing: "missing-task",
      };
      fixture.withRaw((raw) => {
        raw.exec("PRAGMA foreign_keys = ON");

        // Прямой SQL намеренно обходит проверки API для проверки последнего рубежа целостности.
        expect(() => raw.query(sql).run(targets[target])).toThrow(
          expect.objectContaining({ code: expectedCode }),
        );
        expect(raw.query("SELECT id, task_id FROM task_comments ORDER BY id").all()).toEqual([
          { id: entry.id, task_id: task.id },
        ]);
      });

      expect(db.get(task.id)).toEqual(appended);
      expect(db.getGeneration()).toBe(generation);
    },
  );

  test("вставка задачи с непустой проекцией журнала отклоняется без частичной записи", () => {
    const db = fixture.create();
    const comment = createComment();
    const task = createTask(db, "TASK-1", { comments: [comment] });
    const generation = db.getGeneration();

    expectRelayError(() => db.insert(task), "VALIDATION_ERROR");

    expect(db.get(task.id)).toBeUndefined();
    expect(db.get(task.key)).toBeUndefined();
    expect(db.getGeneration()).toBe(generation);
    fixture.withRaw((raw) => {
      expect(raw.query("SELECT id FROM task_comments WHERE id = ?").get(comment.id)).toBeNull();
    });
  });
});
