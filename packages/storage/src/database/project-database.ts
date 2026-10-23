import type { Database } from "bun:sqlite";
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
import { insertBatchReceipt, readBatchReceipt } from "../batch/batch-receipts";
import type { StoredBatchReceipt } from "../batch/batch-receipt.types";
import {
  countEntities,
  entityWindow,
  findAddressIdentities,
  getEntities,
  getEntity,
  getEntityIdentities,
  getEntityIdentity,
  getEntityRevision,
  getEntitySummaries,
  hasEntityArrayItemByField,
  listEntities,
  listEntitiesByField,
  listEntityIdentitiesByField,
  resolveEntityReferences,
  taskGraphRecords,
} from "../entities/entity-queries";
import type {
  EntityIdentityWithRevision,
  EntitySummaryProjection,
} from "../entities/entity-queries.types";
import {
  appendComment,
  decodeTaskComment,
  insertEntity,
  nextAvailableKey,
  revisionConflict,
  updateEntity,
} from "../entities/entity-writes";
import { entityMessages } from "../entities/entity.messages";
import { errorCode, storageError } from "../sqlite/sqlite-errors";
import { isAsyncFunction, isPromiseLike } from "../sqlite/transaction-callback";
import type { SynchronousOperation, TransactionMode } from "../sqlite/transaction.types";
import {
  configureProjectWal,
  connectProjectFile,
  discardProjectFile,
  initialProjectRecords,
  initializeProjectSchema,
  readProjectId,
  reserveProjectFile,
} from "./project-file";
import type { ProjectGenerationRow, ProjectMetadata } from "./project-database.types";
import { projectDatabaseMessages } from "./project-database.messages";

/**
 * Владеет одним синхронным соединением проекта, границами транзакций и переводом ошибок SQLite.
 * Предметную форму содержания проверяет Core; Storage обеспечивает CAS, ссылки и атомарность.
 * Создавший или открывший базу обязан закрыть её после завершения сценария.
 */
export class ProjectDatabase {
  /* Абсолютный путь файловой базы; WAL и SHM располагаются рядом. */
  readonly path: string;
  /* Постоянный ID корневой сущности проекта. */
  readonly projectId: string;
  /* Единственное принадлежащее экземпляру соединение SQLite. */
  private readonly connection: Database;
  /* Число активных внешних транзакций и вложенных savepoint в текущем стеке. */
  private depth = 0;
  /* Монотонный номер savepoint, исключающий повтор имени во вложенном вызове. */
  private savepoint = 0;
  /* Признак завершённого владения соединением; повторное close допустимо. */
  private closed = false;

  /**
   * Принимает владение настроенным соединением, уже связанным с проверенным ID проекта.
   */
  private constructor(path: string, connection: Database, projectId: string) {
    this.path = path;
    this.connection = connection;
    this.projectId = projectId;
  }

  /**
   * Эксклюзивно создаёт файловую WAL-базу и атомарно записывает схему и три начальные сущности.
   * Существующий файл не изменяет; при отказе удаляет созданные этой попыткой файлы SQLite.
   */
  static create(path: string, project: ProjectMetadata): ProjectDatabase {
    path = resolve(path);
    reserveProjectFile(path, project);
    let connection: Database | undefined;
    try {
      const opened = connectProjectFile(path);
      connection = opened;
      configureProjectWal(opened);
      const db = new ProjectDatabase(path, opened, project.id);
      db.transaction(() => {
        initializeProjectSchema(opened, project.id);
        for (const entity of initialProjectRecords(project)) {
          db.insert(entity);
        }
      });
      return db;
    } catch (error) {
      connection?.close();
      discardProjectFile(path);
      throw storageError(error, path);
    }
  }

  /**
   * Открывает существующую совместимую базу, проверяя приложение, версию и корневую сущность.
   * Техническая схема v1 атомарно обновляется до v2 с сохранением предметных данных и поколения.
   * Не создаёт отсутствующий файл; при отказе освобождает временно открытое соединение.
   */
  static open(path: string): ProjectDatabase {
    path = resolve(path);
    let connection: Database | undefined;
    try {
      connection = connectProjectFile(path);
      const projectId = readProjectId(connection, path);
      configureProjectWal(connection);
      return new ProjectDatabase(path, connection, projectId);
    } catch (error) {
      connection?.close();
      if (errorCode(error) === "ENOENT") {
        const missing = new RelayError(
          "DATABASE_NOT_FOUND",
          projectDatabaseMessages.databaseMissing,
          3,
          {
            path,
          },
        );
        missing.cause = error;
        throw missing;
      }
      throw storageError(error, path);
    }
  }

  /**
   * Освобождает соединение; повторный вызов ничего не меняет.
   * Внутри transaction/snapshot запрещён, чтобы не разорвать атомарность вызывающего.
   */
  close(): void {
    if (this.closed) {
      return;
    }
    if (this.depth > 0) {
      throw new RelayError("TRANSACTION_ACTIVE", projectDatabaseMessages.transactionActive);
    }
    this.connection.close();
    this.closed = true;
  }

  /**
   * Выполняет синхронное обращение к открытому соединению с переводом технических ошибок.
   * Самостоятельный снимок не начинает: согласованность нескольких запросов задаёт вызывающий.
   */
  private withOpenConnection<T>(operation: () => T): T {
    if (this.closed) {
      throw new RelayError("DATABASE_CLOSED", projectDatabaseMessages.databaseClosed);
    }
    try {
      return operation();
    } catch (error) {
      throw storageError(error, this.path);
    }
  }

  /**
   * Выполняет синхронную атомарную запись под BEGIN IMMEDIATE; вложенный вызов создаёт savepoint.
   * Исключение откатывает собственную область, включая поколение, алиасы и счётчики.
   * Async-функция не запускается; возвращённый thenable вызывает rollback и ASYNC_TRANSACTION.
   */
  transaction<T>(operation: SynchronousOperation<T>): T {
    return this.runTransaction<T>("IMMEDIATE", operation);
  }

  /**
   * Удерживает согласованный снимок с первого чтения без предварительной блокировки писателя.
   * Вложенный вызов наследует внешнюю транзакцию через savepoint; callback строго синхронный.
   * Запись разрешена SQLite, но устаревший снимок нельзя повысить до писателя: возникает STORAGE_BUSY.
   */
  snapshot<T>(operation: SynchronousOperation<T>): T {
    return this.runTransaction<T>("DEFERRED", operation);
  }

  /**
   * Управляет одной внешней транзакцией либо savepoint, сохраняя глубину после любого исхода.
   * Перехваченный отказ вложенного вызова не оставляет его записи во внешней транзакции.
   */
  private runTransaction<T>(mode: TransactionMode, operation: SynchronousOperation<T>): T {
    if (isAsyncFunction(operation)) {
      throw new RelayError("ASYNC_TRANSACTION", projectDatabaseMessages.asyncCallback);
    }
    return this.withOpenConnection(() => {
      const nested = this.depth > 0;
      if (nested && !this.connection.inTransaction) {
        throw new RelayError("TRANSACTION_ABORTED", projectDatabaseMessages.transactionAborted);
      }
      const point = `relay_${++this.savepoint}`;
      // Savepoint наследует режим внешней транзакции, а DEFERRED фиксирует снимок первым чтением.
      this.connection.exec(nested ? `SAVEPOINT ${point}` : `BEGIN ${mode}`);
      this.depth++;
      try {
        const result = operation();
        if (isPromiseLike(result)) {
          // Ошибка API не должна дополнительно создавать необработанный rejection.
          void Promise.resolve(result).catch(() => {});
          throw new RelayError("ASYNC_TRANSACTION", projectDatabaseMessages.asyncResult);
        }
        this.connection.exec(nested ? `RELEASE SAVEPOINT ${point}` : "COMMIT");
        return result;
      } catch (error) {
        if (this.connection.inTransaction) {
          if (nested) {
            this.connection.exec(`ROLLBACK TO SAVEPOINT ${point}; RELEASE SAVEPOINT ${point}`);
          } else {
            this.connection.exec("ROLLBACK");
          }
        }
        throw error;
      } finally {
        this.depth--;
      }
    });
  }

  /**
   * Читает полную карточку и журнал по ID, ключу или алиасу одним SQL-запросом.
   * Несуществующая ссылка и несовпадение вида возвращают undefined.
   */
  get(ref: string, kind?: EntityKind): EntityRecord | undefined {
    return this.withOpenConnection(() => getEntity(this.connection, ref, kind));
  }

  /**
   * Разрешает ID, ключ или алиас без чтения JSON и журнала; отсутствие возвращает undefined.
   */
  getIdentity(ref: string, kind?: EntityKind): EntityIdentity | undefined {
    return this.withOpenConnection(() => getEntityIdentity(this.connection, ref, kind));
  }

  /**
   * Читает полные карточки и журналы только запрошенных постоянных ID одним SQL-запросом.
   * Сохраняет порядок и повторы ID, пропуская отсутствующие записи и несовпадающий вид.
   * Ключи и алиасы не разрешаются; пустой пакет возвращает пустой массив без SQL.
   */
  getMany(ids: readonly string[], kind?: EntityKind): EntityRecord[] {
    return this.withOpenConnection(() => getEntities(this.connection, ids, kind));
  }

  /**
   * Читает идентичности запрошенных постоянных ID одним SQL-запросом без JSON и журналов.
   * Порядок, повторы и пропуски соответствуют getMany; ключи и алиасы не разрешаются.
   * Пустой пакет возвращает пустой массив без SQL; отсутствующие и чужие ссылки проверяет Core.
   */
  getManyIdentities(ids: readonly string[], kind?: EntityKind): EntityIdentity[] {
    return this.withOpenConnection(() => getEntityIdentities(this.connection, ids, kind));
  }

  /**
   * Разрешает обычные ID, ключи и алиасы одним запросом без содержания и журналов.
   * Каждому входу соответствует идентичность либо null; порядок и повторы сохраняются.
   * Типизированные и виртуальные адреса разрешает Core; общий снимок удерживает вызывающий.
   */
  resolveMany(refs: readonly string[]): (EntityIdentity | null)[] {
    return this.withOpenConnection(() => resolveEntityReferences(this.connection, refs));
  }

  /**
   * Читает краткие сырые проекции постоянных ID без полных текстов, составов и журналов.
   * null явно обозначает отсутствующий ID; порядок и повторы входа сохраняются.
   * Предметные поля проверяет Core, согласованность с адресацией удерживает внешний snapshot.
   */
  getManySummaries(ids: readonly string[]): (EntitySummaryProjection | null)[] {
    return this.withOpenConnection(() => getEntitySummaries(this.connection, ids));
  }

  /**
   * Ищет точные строковые slug/prefix внутри вида, без выдачи содержания, в порядке ID.
   * Приоритет адресов, допустимые виды виртуальных ссылок и неоднозначность проверяет Core.
   */
  findAddressIdentities(ref: string, kind: EntityKind): EntityIdentity[] {
    return this.withOpenConnection(() => findAddressIdentities(this.connection, ref, kind));
  }

  /**
   * Загружает все карточки выбранного вида с комментариями по ключу и ID одним запросом.
   * Отсутствие вида означает все сущности проекта; для ограниченной выдачи предназначен listPage.
   */
  list(kind?: EntityKind): EntityRecord[] {
    return this.withOpenConnection(() => listEntities(this.connection, kind));
  }

  /**
   * Читает карточки вида с точным строковым полем верхнего уровня JSON одним SQL-запросом.
   * Имя поля сравнивается буквально, не как JSON-путь; порядок — по ключу и ID.
   * Фильтрация выполняется в SQLite; в TypeScript передаются только выбранные карточки и журналы.
   */
  listByField(kind: EntityKind, field: string, value: string): EntityRecord[] {
    return this.withOpenConnection(() => listEntitiesByField(this.connection, kind, field, value));
  }

  /**
   * Читает только ID, вид, ключ и ревизию записей с точным строковым полем верхнего уровня JSON.
   * Имя поля буквальное, порядок — по ключу и ID; отсутствие совпадений возвращает пустой массив.
   * JSON-содержание и журналы не передаются из SQLite. Общий снимок нескольких чтений задаёт вызывающий.
   */
  listIdentitiesByField(
    kind: EntityKind,
    field: string,
    value: string,
  ): EntityIdentityWithRevision[] {
    return this.withOpenConnection(() =>
      listEntityIdentitiesByField(this.connection, kind, field, value),
    );
  }

  /**
   * Проверяет существование записи вида с объектом в верхнеуровневом массиве arrayField.
   * Поле itemField объекта должно точно совпадать со строкой value; имена полей буквальные.
   * Неподходящие формы и отсутствие совпадений дают false. Один SQL-запрос не загружает содержание.
   * Общий snapshot/transaction задаёт вызывающий; закрытая база даёт DATABASE_CLOSED.
   */
  hasArrayItemByField(
    kind: EntityKind,
    arrayField: string,
    itemField: string,
    value: string,
  ): boolean {
    return this.withOpenConnection(() =>
      hasEntityArrayItemByField(this.connection, kind, arrayField, itemField, value),
    );
  }

  /**
   * Возвращает число записей текущего снимка без чтения JSON и журнала комментариев.
   */
  count(kind?: EntityKind): number {
    return this.withOpenConnection(() => countEntities(this.connection, kind));
  }

  /**
   * Читает только выбранное SQL-окно и полный счётчик в одном снимке.
   * Содержание и комментарии остальных записей не загружаются. Сортировка updated убывает,
   * остальные возрастают; постоянный ID стабилизирует порядок одинаковых значений.
   */
  listPage(kind: EntityKind, options: EntityPageRequest): EntityPage<EntityRecord> {
    validateEntityPageRequest(options);
    return this.snapshot(() => ({
      total: this.count(kind),
      items: entityWindow(this.connection, kind, options),
    }));
  }

  /**
   * Читает обязательства всех задач одним снимком без текста задачи и журнала комментариев.
   * Отсутствующие и неверные обязательства сохраняются для предметного декодера Core.
   */
  listTaskGraph(): EntityRecord[] {
    return this.withOpenConnection(() => taskGraphRecords(this.connection));
  }

  /**
   * Атомарно вставляет сущность, её ID/ключ и прирост поколения; начальные комментарии запрещены.
   * Коллизии и нарушение SQL-ограничений дают CONFLICT без частично записанных данных.
   */
  insert(entity: EntityRecord): void {
    this.transaction(() => insertEntity(this.connection, entity));
  }

  /**
   * Атомарно заменяет содержание по постоянному ID и ожидаемой ревизии, сохраняя журнал задачи.
   * Вызывающий передаёт следующую ревизию; no-op здесь не распознаётся, SQL требует прирост на один.
   * Отсутствующий ID даёт NOT_FOUND, устаревшая ревизия — REVISION_CONFLICT до попытки записи.
   * Предварительная проверка читает только ID и ревизию; неизменяемые поля защищает SQL.
   */
  update(entity: EntityRecord, expectedRevision: number): void {
    this.transaction(() => {
      const current = getEntityRevision(this.connection, entity.id);
      if (!current) {
        throw new RelayError("NOT_FOUND", entityMessages.entityMissing, 3, { id: entity.id });
      }
      if (current.revision !== expectedRevision) {
        throw revisionConflict(current, expectedRevision);
      }
      if (!updateEntity(this.connection, entity, expectedRevision)) {
        throw revisionConflict(current, expectedRevision);
      }
    });
  }

  /**
   * Атомарно резервирует следующий номер префикса, пропуская все занятые ID, ключи и алиасы.
   * Откат внешней транзакции возвращает счётчик; само резервирование не меняет поколение сущностей.
   */
  nextKey(prefix: string): string {
    if (!prefix || prefix.trim() !== prefix || /\s|\p{Cc}|:/u.test(prefix)) {
      throw new RelayError("VALIDATION_ERROR", entityMessages.invalidPrefix, 2);
    }
    return this.transaction(() => nextAvailableKey(this.connection, prefix));
  }

  /**
   * Атомарно добавляет комментарий по ID, ключу или алиасу задачи и возвращает полную карточку.
   * Журнал и поколение меняются независимо от ревизии содержания; повтор ID даёт CONFLICT.
   * Техническая форма проверяется здесь, предметные правила комментария принадлежат Core.
   */
  appendTaskComment(ref: string, comment: Record<string, unknown>): EntityRecord {
    const entry = decodeTaskComment(comment);
    return this.transaction(() => {
      const task = this.get(ref, "task");
      if (!task) {
        throw new RelayError("NOT_FOUND", entityMessages.taskMissing, 3, { ref });
      }
      appendComment(this.connection, task.id, entry);
      const appended = this.get(task.id, "task");
      if (!appended) {
        throw new RelayError("STORAGE_ERROR", entityMessages.commentTaskMissing, 1, {
          id: task.id,
        });
      }
      return appended;
    });
  }

  /**
   * Атомарно меняет читаемый ключ по постоянному ID, сохраняя прежний алиас и увеличивая ревизию.
   * Ключ и алиас вместо ID не принимаются; их заранее разрешает вызывающий Core.
   * При прежнем ключе возвращает текущую карточку без записи, но только после проверки CAS.
   * Полное содержание и журнал для результата читаются один раз в той же транзакции.
   */
  rename(id: string, key: string, expectedRevision: number, actor: string): EntityRecord {
    // Двоеточие принадлежит синтаксису kind:ref, а не пространству читаемых ключей.
    if (typeof key !== "string" || !key || /\s|\p{Cc}|:/u.test(key)) {
      throw new RelayError("VALIDATION_ERROR", entityMessages.invalidKey, 2);
    }
    return this.transaction(() => {
      const current = this.get(id);
      if (!current || current.id !== id) {
        throw new RelayError("NOT_FOUND", entityMessages.entityMissing, 3, { id });
      }
      if (current.revision !== expectedRevision) {
        throw revisionConflict(current, expectedRevision);
      }
      if (current.key === key) {
        return current;
      }
      const renamed = {
        ...current,
        key,
        revision: current.revision + 1,
        updatedBy: actor,
        updatedAt: new Date().toISOString(),
      };
      if (!updateEntity(this.connection, renamed, expectedRevision)) {
        throw revisionConflict(current, expectedRevision);
      }
      return renamed;
    });
  }

  /**
   * Возвращает поколение текущего снимка; отсутствие обязательного состояния считается повреждением.
   * Для согласования с составным чтением вызывается внутри общего snapshot.
   */
  getGeneration(): number {
    return this.withOpenConnection(() => {
      const state = this.connection
        .query<ProjectGenerationRow, []>("SELECT generation FROM project_state WHERE singleton = 1")
        .get();
      if (!state) {
        throw new RelayError("DATABASE_INVALID", projectDatabaseMessages.generationMissing, 1, {
          path: this.path,
        });
      }
      return state.generation;
    });
  }

  /**
   * Возвращает первоначальную квитанцию либо undefined; текущие сущности не читаются.
   */
  getBatchReceipt(operationKey: string): StoredBatchReceipt | undefined {
    return this.withOpenConnection(() => readBatchReceipt(this.connection, operationKey));
  }

  /**
   * Атомарно добавляет неизменяемую квитанцию; внешняя транзакция объединяет её с предметными записями.
   * Повтор ключа даёт CONFLICT; поколение данных не меняется.
   */
  insertBatchReceipt(receipt: StoredBatchReceipt): void {
    this.transaction(() => insertBatchReceipt(this.connection, receipt));
  }
}
