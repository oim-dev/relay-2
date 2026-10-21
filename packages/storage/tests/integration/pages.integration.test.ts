import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import type { EntityRecord } from "@relay/contracts";
import { ProjectDatabase } from "../../src";

const artifacts = resolve(
  import.meta.dir,
  "../../../..",
  ".artifacts",
  new Date().toISOString().slice(0, 10),
);
let directory: string;
let db: ProjectDatabase;

beforeEach(() => {
  mkdirSync(artifacts, { recursive: true });
  directory = mkdtempSync(join(artifacts, "storage-pages-"));
  db = ProjectDatabase.create(join(directory, "project.sqlite"), {
    id: "project-id",
    name: "Страницы",
    slug: "pages",
  });
});

afterEach(() => {
  db.close();
  rmSync(directory, { recursive: true, force: true });
});

// Storage проверяет техническое окно JSON-записей; предметная модель принадлежит Core.
function document(key: string, name: string, body = "Полное содержание"): EntityRecord {
  return {
    id: crypto.randomUUID(),
    kind: "document",
    key,
    revision: 1,
    createdAt: "2026-10-21T00:00:00.000Z",
    updatedAt: "2026-10-21T00:00:00.000Z",
    createdBy: "author",
    updatedBy: "author",
    data: { name, body },
  };
}

test("окно сохраняет полное содержание выбранной записи, не декодируя остальные", () => {
  const first = document("DOC-1", "Я");
  const second = document("DOC-2", "А", "НЕЗАГРУЖЕННОЕ-СОДЕРЖАНИЕ");
  db.insert(first);
  db.insert(second);
  const parse = JSON.parse;
  const decoded: string[] = [];
  const decoder = spyOn(JSON, "parse").mockImplementation((text, reviver) => {
    decoded.push(text);
    return parse(text, reviver);
  });
  try {
    expect(db.listPage("document", { offset: 0, limit: 1, sort: "key" })).toEqual({
      total: 2,
      items: [first],
    });
    expect(decoded.some((text) => text.includes("НЕЗАГРУЖЕННОЕ-СОДЕРЖАНИЕ"))).toBe(false);
  } finally {
    decoder.mockRestore();
  }
  expect(db.listPage("document", { offset: 0, limit: 1, sort: "title" }).items).toEqual([second]);
  expect(db.listPage("document", { offset: 1, limit: 1, sort: "key" }).items).toEqual([second]);
  expect(db.listPage("document", { offset: 2, limit: 1, sort: "key" })).toEqual({
    total: 2,
    items: [],
  });
});

test("счётчик и окно относятся к одному снимку при конкурентном добавлении", () => {
  const first = document("DOC-1", "Первая запись");
  db.insert(first);
  const writer = ProjectDatabase.open(db.path);
  const count = db.count.bind(db);
  const counter = spyOn(db, "count").mockImplementation((kind) => {
    const total = count(kind);
    writer.insert(document("DOC-2", "Конкурентная запись"));
    return total;
  });
  try {
    expect(db.listPage("document", { offset: 0, limit: 10, sort: "key" })).toEqual({
      total: 1,
      items: [first],
    });
  } finally {
    counter.mockRestore();
    writer.close();
  }
  expect(db.count("document")).toBe(2);
});

test("граф задач не загружает текст и независимый журнал комментариев", () => {
  const task: EntityRecord = {
    ...document("TASK-1", "Техническая задача"),
    kind: "task",
    data: {
      description: "ТЕКСТ-ЗАДАЧИ",
      column: "ready",
      parentId: null,
      dependencies: [],
      acceptanceCriteria: [{ completed: false, description: "ТЕКСТ-КРИТЕРИЯ" }],
    },
  };
  db.insert(task);
  db.appendTaskComment(task.id, {
    id: "comment-id",
    title: "Комментарий",
    body: "ТЕКСТ-КОММЕНТАРИЯ",
    createdAt: task.createdAt,
    createdBy: "author",
  });
  expect(db.listTaskGraph()).toEqual([
    {
      ...task,
      data: {
        column: "ready",
        parentId: null,
        dependencies: [],
        acceptanceCriteria: [{ completed: false }],
      },
    },
  ]);
});

test("проекция идентичности разрешает ключи, алиасы и адреса без десериализации JSON", () => {
  const first: EntityRecord = {
    ...document("BOARD-1", "Первая доска", "НЕ-ЧИТАТЬ-СОДЕРЖАНИЕ-ДОСКИ"),
    kind: "board",
    data: { slug: "shared", prefix: "FIRST", description: "НЕ-ЧИТАТЬ-СОДЕРЖАНИЕ-ДОСКИ" },
  };
  const second: EntityRecord = {
    ...document("BOARD-2", "Вторая доска"),
    kind: "board",
    data: { slug: "second", prefix: "shared" },
  };
  // Storage возвращает все технические совпадения; решение о неоднозначности принадлежит Core.
  db.insert(first);
  db.insert(second);
  const renamed = db.rename(first.id, "BOARD-RENAMED", first.revision, "author");
  const identity = { id: first.id, kind: first.kind, key: renamed.key };
  const decoder = spyOn(JSON, "parse");
  try {
    for (const ref of [first.id, first.key, renamed.key])
      expect(db.getIdentity(ref, "board")).toEqual(identity);
    expect(db.getIdentity(first.id, "task")).toBeUndefined();
    expect(db.getIdentity("missing")).toBeUndefined();
    expect(db.findAddressIdentities("shared", "board")).toEqual(
      [identity, { id: second.id, kind: second.kind, key: second.key }].sort((a, b) =>
        a.id.localeCompare(b.id),
      ),
    );
    expect(db.findAddressIdentities("shared", "application")).toEqual([]);
    expect(decoder).not.toHaveBeenCalled();
  } finally {
    decoder.mockRestore();
  }
});
