import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import type { EntityRecord, TaskComment } from "@relay/contracts";
import { ProjectDatabase } from "../../../src/database/project-database";
import { batchUpgradeV1Schema } from "./batch-receipt-v1-schema";

const legacyMetadata = {
  revision: 1,
  createdAt: "2026-09-01T10:00:00.000Z",
  updatedAt: "2026-09-12T11:00:00.000Z",
  createdBy: "legacy-author",
  updatedBy: "legacy-editor",
} as const;

export const batchUpgradeDocument: EntityRecord = {
  ...legacyMetadata,
  id: "legacy-document",
  kind: "document",
  key: "DOC-7",
  revision: 4,
  data: {
    name: "Сохранённый документ",
    body: "# Решение\n\nСохранить **Markdown** и ё.",
    tags: [],
  },
};

export const batchUpgradeTask: EntityRecord = {
  ...legacyMetadata,
  id: "legacy-task",
  kind: "task",
  key: "TASK-3",
  revision: 2,
  data: { title: "Старая задача", description: "Содержание отдельно от журнала" },
};

export const batchUpgradeRecords: readonly EntityRecord[] = [
  {
    ...legacyMetadata,
    id: "legacy-project",
    kind: "project",
    key: "PROJECT",
    data: { name: "Исторический проект", slug: "legacy-project" },
  },
  { ...legacyMetadata, id: "legacy-product", kind: "product", key: "PRODUCT", data: {} },
  {
    ...legacyMetadata,
    id: "legacy-board",
    kind: "board",
    key: "BOARD-PRODUCT",
    data: { name: "Продукт", slug: "product", prefix: "PRODUCT" },
  },
  batchUpgradeDocument,
  batchUpgradeTask,
];

export const batchUpgradeComments: readonly TaskComment[] = [
  {
    id: "legacy-comment-first",
    title: "Первое сообщение",
    body: "Журнал до миграции\nс переводом строки",
    createdAt: "2026-09-10T15:00:00.000Z",
    createdBy: "legacy-reviewer",
  },
  {
    id: "legacy-comment-second",
    title: "Второе сообщение",
    body: "Порядок публикаций не зависит от часов автора",
    createdAt: "2026-09-09T14:00:00.000Z",
    createdBy: "legacy-author",
  },
];

export const batchUpgradeGeneration = 83;

/**
 * Создаёт заполненную файловую v1 по замороженной схеме без вызова текущих create/open.
 * SQL подготавливает исторический снимок с алиасами, зарезервированными номерами и журналом;
 * поколение намеренно не выводится из числа сохранившихся сущностей.
 */
function createLegacyDatabase(path: string): void {
  const raw = new Database(path, { create: true, strict: true });
  try {
    raw.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; BEGIN IMMEDIATE;");
    raw.exec(batchUpgradeV1Schema);
    raw.exec("PRAGMA application_id = 0x524c5932; PRAGMA user_version = 1;");
    raw.exec("INSERT INTO project_state VALUES (1, 'legacy-project', 0)");
    const insert = raw.query("INSERT INTO entities VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
    for (const record of batchUpgradeRecords) {
      insert.run(
        record.id,
        record.kind,
        record.key,
        record.revision,
        record.createdAt,
        record.updatedAt,
        record.createdBy,
        record.updatedBy,
        JSON.stringify(record.data),
      );
    }
    raw.exec(`
      INSERT INTO entity_refs VALUES ('DOC-1', 'legacy-document'), ('DOC-4', 'legacy-document');
      INSERT INTO key_counters VALUES ('DOC', 17), ('TASK', 11), ('RESERVED', 6);
    `);
    const append = raw.query(
      "INSERT INTO task_comments(id, task_id, title, body, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?)",
    );
    for (const comment of batchUpgradeComments) {
      append.run(
        comment.id,
        batchUpgradeTask.id,
        comment.title,
        comment.body,
        comment.createdAt,
        comment.createdBy,
      );
    }
    raw.query("UPDATE project_state SET generation = ?").run(batchUpgradeGeneration);
    raw.exec("COMMIT");
  } finally {
    if (raw.inTransaction) {
      raw.exec("ROLLBACK");
    }
    raw.close();
  }
}

/**
 * Владеет файлом исторической базы и соединениями проверяемого публичного API.
 * Создание fixture резервирует только каталог; close очищает его и все соединения.
 */
export class BatchReceiptUpgradeFixture {
  /* Отдельный каталог теста внутри артефактов области storage-upgrade. */
  readonly directory: string;
  /* Путь единственной файловой базы теста; изначально файла нет. */
  readonly path: string;
  /* Успешно открытые соединения для очистки даже при неуспешном утверждении теста. */
  private readonly connections: ProjectDatabase[] = [];

  /**
   * Резервирует уникальный каталог; вызывающий обязан освободить fixture через close.
   */
  constructor() {
    const artifacts = resolve(
      import.meta.dir,
      "../../../../..",
      ".artifacts",
      new Date().toISOString().slice(0, 10),
      "get-batch/storage-upgrade",
    );
    mkdirSync(artifacts, { recursive: true });
    this.directory = mkdtempSync(join(artifacts, "fixture-"));
    this.path = join(this.directory, "project.sqlite");
  }

  /**
   * Подготавливает реальную v1 до проверяемой миграции; соединение подготовки сразу закрывается.
   */
  createV1(): void {
    createLegacyDatabase(this.path);
  }

  /**
   * Открывает базу через публичный API, регистрируя успешное соединение для очистки.
   */
  open(): ProjectDatabase {
    const db = ProjectDatabase.open(this.path);
    this.connections.push(db);
    return db;
  }

  /**
   * Даёт синхронный SQL-доступ только для подготовки повреждения или проверки структуры.
   * Не создаёт отсутствующий файл; закрывает соединение и откатывает незавершённую транзакцию.
   */
  withRaw<T>(
    operation: (raw: Database) => T & (T extends PromiseLike<unknown> ? never : unknown),
  ): T {
    const raw = new Database(this.path, { create: false, readwrite: true, strict: true });
    try {
      return operation(raw);
    } finally {
      if (raw.inTransaction) {
        raw.exec("ROLLBACK");
      }
      raw.close();
    }
  }

  /**
   * Закрывает зарегистрированные соединения и удаляет только собственный каталог fixture.
   */
  close(): void {
    try {
      for (const db of this.connections.toReversed()) {
        db.close();
      }
    } finally {
      rmSync(this.directory, { recursive: true, force: true });
    }
  }
}
