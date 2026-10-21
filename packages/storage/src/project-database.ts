import { Database } from "bun:sqlite";
import { closeSync, openSync, rmSync, statSync } from "node:fs";
import { resolve } from "node:path";
import {
  RelayError,
  validateEntityPageRequest,
  type EntityIdentity,
  type EntityKind,
  type EntityRecord,
  type EntityPage,
  type EntityPageRequest,
} from "@relay/contracts";
import { APPLICATION_ID, SCHEMA, SCHEMA_VERSION } from "./schema";
import {
  countEntities,
  entityWindow,
  findAddressIdentities,
  getEntity,
  getEntityIdentity,
  listEntities,
  taskGraphRecords,
} from "./entity-queries";

export interface ProjectMetadata {
  id: string;
  name: string;
  slug: string;
}

function payload(entity: EntityRecord): string {
  if (entity.kind !== "task") return JSON.stringify(entity.data);
  // Снимок редактора может предшествовать новым комментариям: CAS содержания не заменяет журнал.
  const data = { ...entity.data };
  delete data.comments;
  return JSON.stringify(data);
}

function storageError(error: unknown, path: string): Error {
  if (error instanceof RelayError) return error;
  const code = (error as { code?: string } | null)?.code ?? "";
  // Ошибка сценария сохраняет смысл и стек; преобразуем только ошибки драйвера и файловой системы.
  if (error instanceof Error && !code) return error;
  if (code.startsWith("SQLITE_BUSY") || code.startsWith("SQLITE_LOCKED")) {
    return new RelayError("STORAGE_BUSY", "База занята другой операцией записи.", 4, { path });
  }
  if (code.startsWith("SQLITE_CONSTRAINT")) {
    return new RelayError("CONFLICT", "Нарушено ограничение целостности базы данных.", 4, {
      path,
      reason: error instanceof Error ? error.message : String(error),
    });
  }
  return new RelayError("STORAGE_ERROR", "Ошибка локальной базы данных.", 1, {
    path,
    reason: error instanceof Error ? error.message : String(error),
  });
}

function conflict(entity: EntityRecord, expectedRevision: number): RelayError {
  return new RelayError("REVISION_CONFLICT", "Запись уже изменена; перечитайте её ревизию.", 4, {
    id: entity.id,
    expectedRevision,
    actualRevision: entity.revision,
  });
}

export class ProjectDatabase {
  readonly path: string;
  readonly projectId: string;
  private readonly connection: Database;
  private depth = 0;
  private savepoint = 0;
  private closed = false;

  private constructor(path: string, connection: Database, projectId: string) {
    this.path = path;
    this.connection = connection;
    this.projectId = projectId;
  }

  private static connect(path: string): Database {
    const connection = new Database(path, { create: false, readwrite: true, strict: true });
    try {
      connection.exec("PRAGMA busy_timeout = 1000; PRAGMA foreign_keys = ON;");
      return connection;
    } catch (error) {
      connection.close();
      throw error;
    }
  }

  private static configureWal(connection: Database): void {
    const mode = connection.query<{ journal_mode: string }, []>("PRAGMA journal_mode = WAL").get();
    if (mode?.journal_mode !== "wal") {
      throw new RelayError("STORAGE_ERROR", "Не удалось включить WAL для базы проекта.");
    }
    connection.exec("PRAGMA synchronous = FULL;");
  }

  static create(path: string, project: ProjectMetadata): ProjectDatabase {
    path = resolve(path);
    for (const field of ["id", "name", "slug"] as const) {
      if (typeof project[field] !== "string" || !project[field].trim()) {
        throw new RelayError("VALIDATION_ERROR", `Не задано поле проекта: ${field}.`, 2);
      }
    }
    // Эксклюзивное создание файла защищает от гонки двух init и не затирает чужие данные.
    try {
      closeSync(openSync(path, "wx", 0o600));
    } catch (error) {
      if ((error as { code?: string }).code === "EEXIST") {
        throw new RelayError("DATABASE_EXISTS", "Файл базы данных уже существует.", 4, { path });
      }
      throw storageError(error, path);
    }
    let connection: Database | undefined;
    try {
      connection = ProjectDatabase.connect(path);
      ProjectDatabase.configureWal(connection);
      const db = new ProjectDatabase(path, connection, project.id);
      db.transaction(() => {
        connection!.exec(SCHEMA);
        connection!.exec(
          `PRAGMA application_id = ${APPLICATION_ID}; PRAGMA user_version = ${SCHEMA_VERSION};`,
        );
        connection!.query("INSERT INTO project_state VALUES (1, ?, 0)").run(project.id);
        const now = new Date().toISOString();
        const seed = (id: string, kind: EntityKind, key: string, data: Record<string, unknown>) => {
          db.insert({
            id,
            kind,
            key,
            data,
            revision: 1,
            createdAt: now,
            updatedAt: now,
            createdBy: "system",
            updatedBy: "system",
          });
        };
        seed(project.id, "project", "PROJECT", { name: project.name, slug: project.slug });
        seed(crypto.randomUUID(), "product", "PRODUCT", {});
        seed(crypto.randomUUID(), "board", "BOARD-PRODUCT", {
          name: "Продукт",
          slug: "product",
          prefix: "PRODUCT",
        });
      });
      return db;
    } catch (error) {
      connection?.close();
      for (const suffix of ["", "-wal", "-shm"]) rmSync(`${path}${suffix}`, { force: true });
      throw storageError(error, path);
    }
  }

  static open(path: string): ProjectDatabase {
    path = resolve(path);
    let connection: Database | undefined;
    try {
      if (!statSync(path).isFile()) {
        throw new RelayError("DATABASE_INVALID", "Путь базы данных не является файлом.", 1, {
          path,
        });
      }
      connection = ProjectDatabase.connect(path);
      const version = connection.query<{ user_version: number }, []>("PRAGMA user_version").get();
      const application = connection
        .query<{ application_id: number }, []>("PRAGMA application_id")
        .get();
      if (application?.application_id !== APPLICATION_ID) {
        throw new RelayError("DATABASE_INVALID", "Файл не является базой проекта Relay.", 1, {
          path,
        });
      }
      if (version?.user_version !== SCHEMA_VERSION) {
        throw new RelayError(
          "SCHEMA_VERSION_UNSUPPORTED",
          "Версия схемы базы не поддерживается.",
          1,
          {
            path,
            expectedVersion: SCHEMA_VERSION,
            actualVersion: version?.user_version,
          },
        );
      }
      const state = connection
        .query<{ project_id: string }, []>(
          `
        SELECT project_id FROM project_state s JOIN entities e ON e.id = s.project_id
        WHERE s.singleton = 1 AND e.kind = 'project'
      `,
        )
        .get();
      if (!state)
        throw new RelayError("DATABASE_INVALID", "В базе отсутствует проект.", 1, { path });
      ProjectDatabase.configureWal(connection);
      return new ProjectDatabase(path, connection, state.project_id);
    } catch (error) {
      connection?.close();
      if ((error as { code?: string }).code === "ENOENT") {
        throw new RelayError("DATABASE_NOT_FOUND", "База проекта не найдена.", 3, { path });
      }
      throw storageError(error, path);
    }
  }

  close(): void {
    if (this.closed) return;
    if (this.depth > 0)
      throw new RelayError("TRANSACTION_ACTIVE", "Нельзя закрыть базу внутри транзакции.");
    this.connection.close();
    this.closed = true;
  }

  private read<T>(operation: () => T): T {
    if (this.closed) throw new RelayError("DATABASE_CLOSED", "Соединение с базой уже закрыто.");
    try {
      return operation();
    } catch (error) {
      throw storageError(error, this.path);
    }
  }

  transaction<T>(operation: () => T & (T extends PromiseLike<unknown> ? never : unknown)): T {
    return this.runTransaction<T>("IMMEDIATE", operation);
  }

  snapshot<T>(operation: () => T & (T extends PromiseLike<unknown> ? never : unknown)): T {
    return this.runTransaction<T>("DEFERRED", operation);
  }

  private runTransaction<T>(
    mode: "IMMEDIATE" | "DEFERRED",
    operation: () => T & (T extends PromiseLike<unknown> ? never : unknown),
  ): T {
    if (Object.prototype.toString.call(operation) === "[object AsyncFunction]") {
      throw new RelayError("ASYNC_TRANSACTION", "Транзакция принимает только синхронную функцию.");
    }
    return this.read(() => {
      const nested = this.depth > 0;
      if (nested && !this.connection.inTransaction) {
        throw new RelayError("TRANSACTION_ABORTED", "Внешняя транзакция уже отменена SQLite.");
      }
      const point = `relay_${++this.savepoint}`;
      // DEFERRED фиксирует снимок при первом чтении без блокировки писателя.
      // Savepoint наследует режим внешней транзакции и не начинает отдельную транзакцию.
      this.connection.exec(nested ? `SAVEPOINT ${point}` : `BEGIN ${mode}`);
      this.depth++;
      try {
        const result = operation();
        if (result != null && typeof (result as { then?: unknown }).then === "function") {
          // Ошибка использования API не должна оставлять ещё и необработанный rejection.
          void Promise.resolve(result).catch(() => {});
          throw new RelayError("ASYNC_TRANSACTION", "Транзакция не может возвращать Promise.");
        }
        this.connection.exec(nested ? `RELEASE SAVEPOINT ${point}` : "COMMIT");
        return result;
      } catch (error) {
        // Вложенный отказ откатывает собственные изменения даже при перехвате ошибки снаружи.
        if (this.connection.inTransaction) {
          if (nested)
            this.connection.exec(`ROLLBACK TO SAVEPOINT ${point}; RELEASE SAVEPOINT ${point}`);
          else this.connection.exec("ROLLBACK");
        }
        throw error;
      } finally {
        this.depth--;
      }
    });
  }

  get(ref: string, kind?: EntityKind): EntityRecord | undefined {
    return this.read(() => getEntity(this.connection, ref, kind));
  }

  /** Идентичность по ID/ключу/алиасу без чтения JSON и агрегации комментариев. */
  getIdentity(ref: string, kind?: EntityKind): EntityIdentity | undefined {
    return this.read(() => getEntityIdentity(this.connection, ref, kind));
  }

  /**
   * Технический поиск точного строкового slug/prefix внутри вида, без выдачи содержания.
   * Приоритет адресов, допустимые виды виртуальных ссылок и неоднозначность проверяет Core.
   */
  findAddressIdentities(ref: string, kind: EntityKind): EntityIdentity[] {
    return this.read(() => findAddressIdentities(this.connection, ref, kind));
  }

  list(kind?: EntityKind): EntityRecord[] {
    return this.read(() => listEntities(this.connection, kind));
  }

  /** Число записей без чтения JSON-содержания и журнала комментариев. */
  count(kind?: EntityKind): number {
    return this.read(() => countEntities(this.connection, kind));
  }

  /**
   * Читает только выбранное окно записей и полный счётчик в одном снимке.
   * Содержание и комментарии остальных записей не загружаются. Сортировка
   * updated убывающая; остальные — возрастающие, с постоянным ID для равных ключей.
   */
  listPage(kind: EntityKind, options: EntityPageRequest): EntityPage<EntityRecord> {
    validateEntityPageRequest(options);
    return this.snapshot(() => ({
      total: this.count(kind),
      items: entityWindow(this.connection, kind, options),
    }));
  }

  /**
   * Снимок обязательств всех задач для Core: без текста задачи и журнала комментариев.
   * Отсутствующие/неверные обязательства сохраняются как есть для предметного декодера.
   */
  listTaskGraph(): EntityRecord[] {
    return this.read(() => taskGraphRecords(this.connection));
  }

  insert(entity: EntityRecord): void {
    this.transaction(() => {
      if (
        entity.kind === "task" &&
        Object.hasOwn(entity.data, "comments") &&
        (!Array.isArray(entity.data.comments) || entity.data.comments.length !== 0)
      ) {
        throw new RelayError(
          "VALIDATION_ERROR",
          "Комментарии публикуются отдельной append-only операцией.",
          2,
        );
      }
      this.connection
        .query(
          `
        INSERT INTO entities(id, kind, key, revision, created_at, updated_at, created_by, updated_by, data)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
        )
        .run(
          entity.id,
          entity.kind,
          entity.key,
          entity.revision,
          entity.createdAt,
          entity.updatedAt,
          entity.createdBy,
          entity.updatedBy,
          payload(entity),
        );
    });
  }

  update(entity: EntityRecord, expectedRevision: number): void {
    this.transaction(() => {
      const current = this.get(entity.id);
      if (!current || current.id !== entity.id)
        throw new RelayError("NOT_FOUND", "Запись не найдена.", 3, { id: entity.id });
      if (current.revision !== expectedRevision) throw conflict(current, expectedRevision);
      // run().changes в Bun учитывает побочные изменения триггеров; RETURNING проверяет саму строку CAS.
      const result = this.connection
        .query(
          `
        UPDATE entities SET kind = ?, key = ?, revision = ?, created_at = ?, updated_at = ?,
          created_by = ?, updated_by = ?, data = ? WHERE id = ? AND revision = ? RETURNING id
      `,
        )
        .get(
          entity.kind,
          entity.key,
          entity.revision,
          entity.createdAt,
          entity.updatedAt,
          entity.createdBy,
          entity.updatedBy,
          payload(entity),
          entity.id,
          expectedRevision,
        );
      if (!result) throw conflict(current, expectedRevision);
    });
  }

  nextKey(prefix: string): string {
    if (!prefix || prefix.trim() !== prefix || /\s|\p{Cc}|:/u.test(prefix)) {
      throw new RelayError("VALIDATION_ERROR", "Некорректный префикс ключа.", 2);
    }
    return this.transaction(() => {
      // Счётчик и проверка алиасов защищены одной блокировкой писателя.
      while (true) {
        const counter = this.connection
          .query<{ value: number }, [string]>(
            `
          INSERT INTO key_counters(prefix, value) VALUES (?, 1)
          ON CONFLICT(prefix) DO UPDATE SET value = value + 1 RETURNING value
        `,
          )
          .get(prefix)!;
        const key = `${prefix}-${counter.value}`;
        if (!this.get(key)) return key;
      }
    });
  }

  appendTaskComment(ref: string, comment: Record<string, unknown>): EntityRecord {
    for (const field of ["id", "title", "body", "createdAt", "createdBy"] as const) {
      if (typeof comment[field] !== "string") {
        throw new RelayError(
          "VALIDATION_ERROR",
          `Поле комментария ${field} должно быть строкой.`,
          2,
        );
      }
    }
    return this.transaction(() => {
      const task = this.get(ref, "task");
      if (!task) throw new RelayError("NOT_FOUND", "Задача не найдена.", 3, { ref });
      this.connection
        .query(
          `
        INSERT INTO task_comments(id, task_id, title, body, created_at, created_by)
        VALUES (?, ?, ?, ?, ?, ?)
      `,
        )
        .run(
          comment.id as string,
          task.id,
          comment.title as string,
          comment.body as string,
          comment.createdAt as string,
          comment.createdBy as string,
        );
      return this.get(task.id, "task")!;
    });
  }

  rename(id: string, key: string, expectedRevision: number, actor: string): EntityRecord {
    // Двоеточие принадлежит синтаксису kind:ref, а не пространству читаемых ключей.
    if (typeof key !== "string" || !key || /\s|\p{Cc}|:/u.test(key)) {
      throw new RelayError("VALIDATION_ERROR", "Некорректный читаемый ключ.", 2);
    }
    return this.transaction(() => {
      const current = this.get(id);
      if (!current || current.id !== id)
        throw new RelayError("NOT_FOUND", "Запись не найдена.", 3, { id });
      if (current.revision !== expectedRevision) throw conflict(current, expectedRevision);
      if (current.key === key) return current;
      const renamed = {
        ...current,
        key,
        revision: current.revision + 1,
        updatedBy: actor,
        updatedAt: new Date().toISOString(),
      };
      this.update(renamed, expectedRevision);
      return renamed;
    });
  }

  getGeneration(): number {
    return this.read(
      () =>
        this.connection
          .query<{ generation: number }, []>(
            "SELECT generation FROM project_state WHERE singleton = 1",
          )
          .get()!.generation,
    );
  }
}
