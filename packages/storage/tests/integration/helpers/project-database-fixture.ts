import { Database } from "bun:sqlite";
import { expect } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  RelayError,
  type DocumentData,
  type EntityKind,
  type EntityRecord,
  type KnowledgeRecord,
  type TaskComment,
  type TaskData,
  type TaskRecord,
} from "@relay/contracts";
import { ProjectDatabase } from "../../../src/database/project-database";

export const projectMetadata = {
  id: "project-id",
  name: "Тестовый проект",
  slug: "test-project",
} as const;

/**
 * Владеет отдельным каталогом теста и всеми открытыми через него соединениями проекта.
 * Создание fixture не создаёт БД; тест явно выбирает create либо проверяет отсутствие файла.
 */
export class ProjectDatabaseFixture {
  /* Уникальный каталог под .artifacts текущей даты; удаляется методом close. */
  readonly directory: string;
  /* Абсолютный путь единственной базы этого теста. */
  readonly path: string;
  /* Соединения закрываются в обратном порядке открытия, включая уже закрытые тестом. */
  private readonly connections: ProjectDatabase[] = [];

  /**
   * Резервирует изолированный каталог в выбранной области артефактов текущей даты.
   * Вызывающий обязан вызвать close даже после отказа теста.
   */
  constructor(name = "database", artifactsArea = "database-redesign") {
    const artifacts = resolve(
      import.meta.dir,
      "../../../../..",
      ".artifacts",
      new Date().toISOString().slice(0, 10),
      artifactsArea,
    );
    mkdirSync(artifacts, { recursive: true });
    this.directory = mkdtempSync(join(artifacts, `storage-${name}-`));
    this.path = join(this.directory, "project.sqlite");
  }

  /**
   * Создаёт базу с тремя системными сущностями и регистрирует соединение для очистки.
   */
  create(): ProjectDatabase {
    const db = ProjectDatabase.create(this.path, projectMetadata);
    this.connections.push(db);
    return db;
  }

  /**
   * Открывает ещё одно независимое соединение существующей базы и регистрирует его для очистки.
   */
  open(): ProjectDatabase {
    const db = ProjectDatabase.open(this.path);
    this.connections.push(db);
    return db;
  }

  /**
   * Даёт прямой SQL-доступ для проверки механизма хранения или намеренного повреждения данных.
   * Callback синхронный; оставшаяся транзакция откатывается, соединение закрывается при любом исходе.
   */
  withRaw<T>(
    operation: (connection: Database) => T & (T extends PromiseLike<unknown> ? never : unknown),
  ): T {
    const connection = new Database(this.path, { create: false, readwrite: true });
    try {
      return operation(connection);
    } finally {
      try {
        if (connection.inTransaction) {
          connection.exec("ROLLBACK");
        }
      } finally {
        connection.close();
      }
    }
  }

  /**
   * Закрывает зарегистрированные соединения и удаляет временные файлы теста.
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

/**
 * Формирует документ с полной предметной формой, не сохраняя его в БД.
 * Переопределения задают значимые поля сценария; новый объект и UUID изолированы на вызов.
 */
export function createDocument(
  key = "DOC-1",
  data: Readonly<Partial<DocumentData>> = {},
): KnowledgeRecord<"document"> {
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
    data: {
      name: "Документ",
      summary: "",
      body: "Текст",
      documentKind: "description",
      documentStatus: "draft",
      sectionId: null,
      pinned: false,
      relations: [],
      ...data,
    },
  };
}

/**
 * Формирует задачу существующей продуктовой доски без записи в БД.
 * Журнал по умолчанию пуст; его публикация остаётся отдельным действием теста.
 */
export function createTask(
  db: ProjectDatabase,
  key = "TASK-1",
  data: Readonly<Partial<TaskData>> = {},
): TaskRecord {
  const board = db.getIdentity("BOARD-PRODUCT", "board");
  if (!board) {
    throw new Error("В тестовой базе отсутствует продуктовая доска");
  }
  return {
    ...createDocument(key),
    kind: "task",
    data: {
      boardId: board.id,
      title: "Задача",
      description: "",
      column: "inbox",
      parentId: null,
      dependencies: [],
      related: [],
      targets: [],
      acceptanceCriteria: [],
      comments: [],
      ...data,
    },
  };
}

/**
 * Создаёт новый комментарий с уникальным ID; публикация остаётся явным действием теста.
 */
export function createComment(body = "Комментарий"): TaskComment {
  return {
    id: crypto.randomUUID(),
    title: "Проверка",
    body,
    createdAt: new Date().toISOString(),
    createdBy: "reviewer",
  };
}

/**
 * Проверяет тип и стабильный код синхронного отказа, возвращая ошибку для уточнения деталей.
 * Успешное выполнение или посторонняя ошибка обязательно проваливают проверку.
 */
export function expectRelayError(operation: () => unknown, code: string): RelayError {
  let caught: unknown;
  try {
    operation();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(RelayError);
  if (!(caught instanceof RelayError)) {
    throw new Error("Ожидалась ошибка RelayError", { cause: caught });
  }
  expect(caught.code).toBe(code);
  return caught;
}

/**
 * Читает подготовленную тестом запись и явно проваливает тест при её отсутствии.
 */
export function requireRecord(db: ProjectDatabase, ref: string, kind?: EntityKind): EntityRecord {
  const record = db.get(ref, kind);
  expect(record).toBeDefined();
  if (!record) {
    throw new Error(`Подготовленная запись не найдена: ${ref}`);
  }
  return record;
}
