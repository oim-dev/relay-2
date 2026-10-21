import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { EntityRecord } from "@relay/contracts";
import {
  ProjectDatabaseFixture,
  createComment,
  createDocument,
  expectRelayError,
  requireRecord,
} from "./helpers/project-database-fixture";
import type { CommentConstraintCase } from "./helpers/database-cases.types";

const sqlConstraints: readonly CommentConstraintCase[] = [
  {
    name: "изменение опубликованного комментария",
    sql: "UPDATE task_comments SET body = 'Подмена' WHERE id = ?",
    target: "comment",
    expectedMessage: "append-only",
  },
  {
    name: "удаление опубликованного комментария",
    sql: "DELETE FROM task_comments WHERE id = ?",
    target: "comment",
    expectedMessage: "append-only",
  },
  {
    name: "комментарий к сущности другого вида",
    sql: "INSERT INTO task_comments(id, task_id, title, body, created_at, created_by) VALUES ('new-comment', ?, '', '', '', '')",
    target: "product",
    expectedMessage: "task",
  },
  {
    name: "комментарий к отсутствующей задаче",
    sql: "INSERT INTO task_comments(id, task_id, title, body, created_at, created_by) VALUES ('new-comment', ?, '', '', '', '')",
    target: "missing",
    expectedMessage: "FOREIGN KEY",
  },
  {
    name: "журнал внутри содержания задачи",
    sql: "UPDATE entities SET revision = revision + 1, data = json_set(data, '$.comments', json('[]')) WHERE id = ?",
    target: "task",
    expectedMessage: "CHECK",
  },
];
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
    const task: EntityRecord = {
      ...createDocument("TASK-1"),
      kind: "task",
      data: { title: "Обсуждение" },
    };
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
    db.update(
      { ...stale, revision: 2, updatedBy: "editor", data: { ...stale.data, title: "Уточнение" } },
      1,
    );
    const updated = requireRecord(db, task.id);
    expect(updated.data).toEqual({ title: "Уточнение", comments: [first, second] });
    expect(db.list("task")).toEqual([updated]);
    expect(db.list().find((entity) => entity.id === task.id)).toEqual(updated);
    expect(db.getGeneration()).toBe(generation + 3);
    expectRelayError(() => peer.update({ ...stale, revision: 2 }, 1), "REVISION_CONFLICT");
    fixture.withRaw((raw) => {
      expect(raw.query("SELECT data FROM entities WHERE id = ?").get(task.id)).toEqual({
        data: JSON.stringify({ title: "Уточнение" }),
      });
      expect(
        raw.query("SELECT count(*) AS count FROM task_comments WHERE task_id = ?").get(task.id),
      ).toEqual({ count: 2 });
    });
    db.rename(task.id, "TASK-RENAMED", 2, "editor");
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
    const task: EntityRecord = { ...createDocument("TASK-1"), kind: "task" };
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
    const task: EntityRecord = { ...createDocument("TASK-1"), kind: "task" };
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
      const first: EntityRecord = { ...createDocument("TASK-1"), kind: "task" };
      const second: EntityRecord = { ...createDocument("TASK-2"), kind: "task" };
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
    const task: EntityRecord = { ...createDocument("TASK-1"), kind: "task" };
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
    ({ sql, target, expectedMessage }) => {
      const db = fixture.create();
      const task: EntityRecord = { ...createDocument("TASK-1"), kind: "task" };
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
        expect(() => raw.query(sql).run(targets[target])).toThrow(expectedMessage);
      });

      expect(db.get(task.id)).toEqual(appended);
      expect(db.getGeneration()).toBe(generation);
    },
  );
});
