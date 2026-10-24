import type { Database } from "bun:sqlite";
import { resolve } from "node:path";
import { statSync } from "node:fs";
import {
  RelayError,
  validateEntityPageRequest,
  type EntityIdentity,
  type EntityKind,
  type EntityRecord,
  type EntityPage,
  type EntityPageRequest,
  type PortableProjectSnapshot,
  type ReplicationChangeset,
  type ReplicationConflict,
  type ExpectedEntityAddress,
  type ReplicationStatus,
  type ReplicationReadGuard,
  type CommandStore,
} from "@relay/contracts";
import {
  captureStoredProject,
  flushReplicationQueue,
  readOutbox,
  readReplicationState,
  readReplicationConflicts,
  readReplicationDecisions,
  writeReplicationState,
  readReplicationGuard,
  readReplicationStatus,
} from "../replication/replication-store";
import { importStoredProject } from "../replication/replication-import";
import { storageReplicationMessages } from "../replication/replication.messages";
import { observeReplicationReads } from "../replication/replication-reads";
import {
  readOutboxDependencies,
  readOutboxDigests,
  readOutboxWindow,
} from "../replication/replication-outbox";
import type {
  ReplicationOutboxRequest,
  ReplicationOutboxWindow,
  ReplicationSourceDigest,
  ReplicationDependencySource,
} from "../replication/replication-outbox.types";
import { flushComponentVersions, readComponents } from "../components/component-store";
import { SqliteCommandStore } from "../commands/sqlite-command-store";
import type { PortableComponent } from "@relay/contracts";
import type {
  ReplicationState,
  ReplicationStateUpdate,
  StoredReplicationDecision,
  ReplicationGuard,
  ReplicationImportPlan,
} from "../replication/replication.types";
import type { ReplicationStore, ProjectStorageInfo } from "./project-store.types";
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
import { assertSqlText } from "../entities/entity-sql-text";
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
export class ProjectDatabase implements ReplicationStore {
  /* Абсолютный путь файловой базы; WAL и SHM располагаются рядом. */
  readonly path: string;
  /* Постоянный ID корневой сущности проекта. */
  readonly projectId: string;
  /* Порт команд того же соединения; все сетевые/async ожидания находятся вне SQLite callback. */
  readonly commands: CommandStore;
  /* Единственное принадлежащее экземпляру соединение SQLite. */
  private readonly connection: Database;
  /* Число активных внешних транзакций и вложенных savepoint в текущем стеке. */
  private depth = 0;
  /* Монотонный номер savepoint, исключающий повтор имени во вложенном вызове. */
  private savepoint = 0;
  /* Признак завершённого владения соединением; повторное close допустимо. */
  private closed = false;
  /* Глубина предметных transaction, отличаемая от чтений snapshot для защиты адресного ввода. */
  private writeDepth = 0;
  /* Явные ожидаемые привязки лишь текущего синхронного сценария, не разрешения будущих команд. */
  private referenceGuards: ReadonlyMap<string, string> = new Map();
  /* Счётчик явных write-UOW, отличающий обычный snapshot от legacy записи через вложенный transaction. */
  private writeIntent = 0;

  /**
   * Принимает владение настроенным соединением, уже связанным с проверенным ID проекта.
   */
  private constructor(path: string, connection: Database, projectId: string) {
    this.path = path;
    this.connection = connection;
    this.projectId = projectId;
    this.commands = new SqliteCommandStore(connection, {
      projectId,
      /**
       * Удерживает строго синхронный снимок выбранного соединения.
       */
      snapshot: (operation) => this.snapshot(operation),
      /**
       * Фиксирует exact effects вместе с durable outbox после синхронного callback.
       */
      transaction: (operation) => this.transaction(operation),
    });
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
   * Технические схемы v1/v2/v3 атомарно обновляются до v4 с сохранением данных и исходной очереди.
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
   * Создаёт специальную пустую реплику для последующего bootstrap в Core.
   * Файл эксклюзивен; до bootstrap содержит лишь техническую корневую карточку.
   */
  static createReplica(path: string, projectId: string): ProjectDatabase {
    const db = ProjectDatabase.create(path, { id: projectId, name: "Replica", slug: "replica" });
    try {
      db.transaction(() => {
        db.connection.exec(
          "UPDATE replication_state SET importing=1 WHERE singleton=1; DELETE FROM entity_refs;",
        );
        db.connection.query("DELETE FROM entities WHERE id!=?").run(projectId);
        db.connection.query("INSERT INTO entity_refs VALUES(?,?)").run(projectId, projectId);
        db.connection
          .query("INSERT INTO entity_refs SELECT 'PROJECT',? WHERE ?!='PROJECT'")
          .run(projectId, projectId);
        flushComponentVersions(db.connection);
        db.connection.exec(
          "DELETE FROM replication_outbox; DELETE FROM replication_owner_heads; DELETE FROM replication_entity_queue; DELETE FROM replication_address_queue; DELETE FROM replication_comment_queue; DELETE FROM replication_receipt_queue; DELETE FROM replication_read_queue; DELETE FROM replication_transition_queue; DELETE FROM component_changes; DELETE FROM component_events; UPDATE replication_state SET sequence=0,importing=0 WHERE singleton=1;",
        );
      });
      return db;
    } catch (error) {
      db.close();
      discardProjectFile(db.path);
      throw error;
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
   * Возвращает путь и размер основного SQLite-файла без WAL/SHM; предметный снимок не открывает.
   */
  storageInfo(): ProjectStorageInfo {
    return this.withOpenConnection(() => ({
      databasePath: this.path,
      bytes: statSync(this.path).size,
    }));
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
    const previousIntent = this.writeIntent;
    this.writeDepth++;
    try {
      const result = this.runTransaction<T>("IMMEDIATE", operation);
      this.writeIntent++;
      return result;
    } catch (error) {
      this.writeIntent = previousIntent;
      throw error;
    } finally {
      this.writeDepth--;
    }
  }

  /**
   * Запрещает использовать переназначенный ключ в записи/новой ссылке без явного expectedId.
   * Числовая ревизия другой новой карточки не является достаточной защитой от stale key→ID.
   */
  assertWritableReference(ref: string): void {
    assertSqlText(ref, "ref");
    if (this.writeDepth === 0) {
      return;
    }
    this.withOpenConnection(() => {
      const remapped = this.connection
        .query<{ current_id: string; previous_id: string }, [string]>(
          "SELECT current_id,previous_id FROM replication_remapped_refs WHERE ref=?",
        )
        .get(ref);
      if (remapped !== null && this.referenceGuards.get(ref) !== remapped.current_id) {
        throw new RelayError("ADDRESS_GUARD_REQUIRED", storageReplicationMessages.addressGuard, 4, {
          ref,
          previousId: remapped.previous_id,
          currentId: remapped.current_id,
        });
      }
    });
  }

  /**
   * Удерживает проверенные адресные привязки только до завершения одной атомарной команды.
   * Вложенные guards наследуют внешние; finally возвращает контекст даже при rollback.
   */
  withReferenceGuards<T>(
    guards: readonly ExpectedEntityAddress[],
    operation: SynchronousOperation<T>,
  ): T {
    if (isAsyncFunction(operation)) {
      throw new RelayError("ASYNC_TRANSACTION", projectDatabaseMessages.asyncCallback);
    }
    return this.transaction(() => {
      const previous = this.referenceGuards;
      const current = new Map(previous);
      for (const guard of guards) {
        const actual = this.getIdentity(guard.ref);
        if (actual !== undefined && actual.id !== guard.expectedId) {
          throw new RelayError("ADDRESS_CHANGED", storageReplicationMessages.addressChanged, 4, {
            ref: guard.ref,
            expectedId: guard.expectedId,
            actualId: actual.id,
          });
        }
        current.set(guard.ref, guard.expectedId);
      }
      this.referenceGuards = current;
      try {
        return operation();
      } finally {
        this.referenceGuards = previous;
      }
    });
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
      const writeIntent = this.writeIntent;
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
        if (!nested && (mode === "IMMEDIATE" || this.writeIntent !== writeIntent)) {
          flushComponentVersions(this.connection);
          flushReplicationQueue(this.connection);
        }
        this.connection.exec(nested ? `RELEASE SAVEPOINT ${point}` : "COMMIT");
        return result;
      } catch (error) {
        this.writeIntent = writeIntent;
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
   * Читает карточку и журнал по адресу, гидратируя parts отдельным пакетом в том же snapshot.
   * Несуществующая ссылка и несовпадение вида возвращают undefined.
   */
  get(ref: string, kind?: EntityKind): EntityRecord | undefined {
    return this.snapshot(() => {
      const record = getEntity(this.connection, ref, kind);
      this.observeReads(record === undefined ? [] : [record.id], "content");
      return record;
    });
  }

  /**
   * Разрешает ID, ключ или алиас без чтения JSON и журнала; отсутствие возвращает undefined.
   */
  getIdentity(ref: string, kind?: EntityKind): EntityIdentity | undefined {
    return this.withOpenConnection(() => {
      const record = getEntityIdentity(this.connection, ref, kind);
      this.observeReads(record === undefined ? [] : [record.id], "existence");
      return record;
    });
  }

  /**
   * Читает карточки/журналы запрошенных ID и их parts одним пакетом из того же snapshot.
   * Сохраняет порядок и повторы ID, пропуская отсутствующие записи и несовпадающий вид.
   * Ключи и алиасы не разрешаются; пустой пакет возвращает пустой массив без SQL.
   */
  getMany(ids: readonly string[], kind?: EntityKind): EntityRecord[] {
    return this.snapshot(() => {
      const records = getEntities(this.connection, ids, kind);
      this.observeReads(
        records.map((record) => record.id),
        "content",
      );
      return records;
    });
  }

  /**
   * Читает идентичности запрошенных постоянных ID одним SQL-запросом без JSON и журналов.
   * Порядок, повторы и пропуски соответствуют getMany; ключи и алиасы не разрешаются.
   * Пустой пакет возвращает пустой массив без SQL; отсутствующие и чужие ссылки проверяет Core.
   */
  getManyIdentities(ids: readonly string[], kind?: EntityKind): EntityIdentity[] {
    return this.withOpenConnection(() => {
      const records = getEntityIdentities(this.connection, ids, kind);
      this.observeReads(
        records.map((record) => record.id),
        "existence",
      );
      return records;
    });
  }

  /**
   * Разрешает обычные ID, ключи и алиасы одним запросом без содержания и журналов.
   * Каждому входу соответствует идентичность либо null; порядок и повторы сохраняются.
   * Типизированные и виртуальные адреса разрешает Core; общий снимок удерживает вызывающий.
   */
  resolveMany(refs: readonly string[]): (EntityIdentity | null)[] {
    return this.withOpenConnection(() => {
      const records = resolveEntityReferences(this.connection, refs);
      this.observeReads(
        records.flatMap((record) => (record === null ? [] : [record.id])),
        "existence",
      );
      return records;
    });
  }

  /**
   * Читает краткие сырые проекции постоянных ID без полных текстов, составов и журналов.
   * null явно обозначает отсутствующий ID; порядок и повторы входа сохраняются.
   * Предметные поля проверяет Core, согласованность с адресацией удерживает внешний snapshot.
   */
  getManySummaries(ids: readonly string[]): (EntitySummaryProjection | null)[] {
    return this.withOpenConnection(() => {
      const records = getEntitySummaries(this.connection, ids);
      this.observeReads(
        records.flatMap((record) => (record === null ? [] : [record.id])),
        "content",
      );
      return records;
    });
  }

  /**
   * Ищет точные строковые slug/prefix внутри вида, без выдачи содержания, в порядке ID.
   * Приоритет адресов, допустимые виды виртуальных ссылок и неоднозначность проверяет Core.
   */
  findAddressIdentities(ref: string, kind: EntityKind): EntityIdentity[] {
    return this.withOpenConnection(() => {
      const records = findAddressIdentities(this.connection, ref, kind);
      this.observeReads(
        records.map((record) => record.id),
        "existence",
      );
      return records;
    });
  }

  /**
   * Загружает карточки выбранного вида с комментариями и пакетной гидратацией parts по ключу/ID.
   * Отсутствие вида означает все сущности проекта; для ограниченной выдачи предназначен listPage.
   */
  list(kind?: EntityKind): EntityRecord[] {
    return this.snapshot(() => {
      const records = listEntities(this.connection, kind);
      this.observeReads(
        records.map((record) => record.id),
        "content",
      );
      return records;
    });
  }

  /**
   * Читает карточки по строковому полю JSON и гидратирует parts только отобранных owners.
   * Имя поля сравнивается буквально, не как JSON-путь; порядок — по ключу и ID.
   * Фильтрация выполняется в SQLite; в TypeScript передаются только выбранные карточки и журналы.
   */
  listByField(kind: EntityKind, field: string, value: string): EntityRecord[] {
    return this.snapshot(() => {
      const records = listEntitiesByField(this.connection, kind, field, value);
      this.observeReads(
        records.map((record) => record.id),
        "content",
      );
      return records;
    });
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
    return this.withOpenConnection(() => {
      const records = listEntityIdentitiesByField(this.connection, kind, field, value);
      this.observeReads(
        records.map((record) => record.id),
        "content",
      );
      return records;
    });
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
    return this.withOpenConnection(() => {
      const records = taskGraphRecords(this.connection);
      this.observeReads(
        records.map((record) => record.id),
        "content",
      );
      return records;
    });
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
      const task = getEntity(this.connection, ref, "task");
      if (!task) {
        throw new RelayError("NOT_FOUND", entityMessages.taskMissing, 3, { ref });
      }
      this.observeReads([task.id], "existence");
      appendComment(this.connection, task.id, entry);
      const appended = getEntity(this.connection, task.id, "task");
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
    assertSqlText(operationKey, "operationKey");
    return this.withOpenConnection(() => readBatchReceipt(this.connection, operationKey));
  }

  /**
   * Атомарно добавляет неизменяемую квитанцию; внешняя транзакция объединяет её с предметными записями.
   * Повтор ключа даёт CONFLICT; поколение данных не меняется.
   */
  insertBatchReceipt(receipt: StoredBatchReceipt): void {
    assertSqlText(receipt.operationKey, "operationKey");
    assertSqlText(receipt.requestJson, "requestJson");
    assertSqlText(receipt.resultJson, "resultJson");
    this.transaction(() => insertBatchReceipt(this.connection, receipt));
  }

  /**
   * Возвращает полный сохраняемый переносимый снимок из одной транзакции чтения.
   */
  captureReplication(): PortableProjectSnapshot {
    return this.snapshot(() => captureStoredProject(this.connection, this.projectId));
  }

  /**
   * Читает первичные части выбранных owners либо полный переносимый компонентный снимок.
   * Tombstones включены; пустой ownerIds не загружает данных. Обычные карточки гидратируются отдельно.
   */
  getComponents(ownerIds?: readonly string[]): PortableComponent[] {
    return this.snapshot(() => readComponents(this.connection, ownerIds));
  }

  /**
   * Читает технический курсор и последний принятый remote без сетевых обращений.
   */
  getReplicationState(): ReplicationState {
    return this.withOpenConnection(() => readReplicationState(this.connection));
  }

  /**
   * Возвращает скалярный guard данных, очереди и решений без чтения JSON полного snapshot.
   */
  getReplicationGuard(): ReplicationGuard {
    return this.withOpenConnection(() => readReplicationGuard(this.connection));
  }

  /**
   * Возвращает status одним снимком узких счётчиков, не загружая outbox payload.
   */
  getReplicationStatus(): ReplicationStatus {
    return this.snapshot(() => readReplicationStatus(this.connection));
  }

  /**
   * Декодирует всю очередь для явного полного local overlay; выбор публикации использует отдельное окно.
   */
  getReplicationOutbox(): ReplicationChangeset[] {
    return this.withOpenConnection(() => readOutbox(this.connection));
  }

  /**
   * Читает согласованное ограниченное окно до декодирования payload и точный счётчик остатка.
   */
  getReplicationOutboxWindow(request: ReplicationOutboxRequest): ReplicationOutboxWindow {
    return this.snapshot(() => readOutboxWindow(this.connection, request));
  }

  /**
   * Читает metadata выбранных source ID без JSON-декодирования всей очереди.
   */
  getReplicationOutboxDigests(ids: readonly string[]): ReplicationSourceDigest[] {
    return this.withOpenConnection(() => readOutboxDigests(this.connection, ids));
  }

  /**
   * Явно сканирует dependencies всей очереди для диагностики ожидания, не декодируя source effects.
   */
  getReplicationOutboxDependencies(): ReplicationDependencySource[] {
    return this.withOpenConnection(() => readOutboxDependencies(this.connection));
  }

  /**
   * Читает сохранённые конфликты целых изменений.
   */
  getReplicationConflicts(): ReplicationConflict[] {
    return this.withOpenConnection(() => readReplicationConflicts(this.connection));
  }

  /**
   * Читает решения пользователя, проверяемые Core относительно актуального fingerprint.
   */
  getReplicationDecisions(ids?: readonly string[]): StoredReplicationDecision[] {
    return this.withOpenConnection(() => readReplicationDecisions(this.connection, ids));
  }

  /**
   * Атомарно записывает подтверждения, конфликты и решения без предметного echo-outbox.
   */
  updateReplicationState(update: ReplicationStateUpdate): void {
    this.transaction(() => writeReplicationState(this.connection, update));
  }

  /**
   * Применяет предметно проверенный снимок, не заменяя файл БД и не создавая echo-outbox.
   */
  importReplication(snapshot: PortableProjectSnapshot, plan?: ReplicationImportPlan): void {
    this.transaction(() => importStoredProject(this.connection, snapshot, plan));
  }

  /**
   * Восстанавливает лишь пустую createReplica-базу; рабочие данные заменять запрещено.
   */
  bootstrapReplication(snapshot: PortableProjectSnapshot): void {
    this.transaction(() => {
      const state = this.getReplicationState();
      if (
        state.sequence !== 0 ||
        state.base !== null ||
        this.count() !== 1 ||
        snapshot.projectId !== this.projectId
      ) {
        throw new RelayError("REPLICATION_NOT_EMPTY", storageReplicationMessages.bootstrap, 4);
      }
      this.connection.exec(
        "UPDATE replication_state SET importing=1 WHERE singleton=1; DELETE FROM entity_refs;",
      );
      // Отложенный FK project_state допускает замену технической корневой карточки внутри транзакции.
      this.connection.exec("DELETE FROM entities");
      importStoredProject(this.connection, snapshot);
      writeReplicationState(this.connection, { base: snapshot, conflicts: [] });
    });
  }

  /**
   * Добавляет семантические основания лишь активной записи; обычные чтения не создают SQL-очередей.
   */
  private observeReads(ids: readonly string[], kind: ReplicationReadGuard["kind"]): void {
    if (this.writeDepth > 0 && ids.length > 0) {
      observeReplicationReads(this.connection, ids, kind);
    }
  }
}
