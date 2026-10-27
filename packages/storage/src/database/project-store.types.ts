import type {
  EntityIdentity,
  EntityKind,
  EntityRecord,
  EntityPage,
  EntityPageRequest,
  PortableProjectSnapshot,
  ReplicationChangeset,
  ReplicationConflict,
  ExpectedEntityAddress,
  ReplicationStatus,
  CommandStore,
  PortableComponent,
} from "@relay/contracts";
import type { StoredBatchReceipt } from "../batch/batch-receipt.types";
import type {
  EntityIdentityWithRevision,
  EntitySummaryProjection,
} from "../entities/entity-queries.types";
import type { SynchronousOperation } from "../sqlite/transaction.types";
import type {
  ReplicationOutboxRequest,
  ReplicationOutboxWindow,
  ReplicationSourceDigest,
  ReplicationDependencySource,
} from "../replication/replication-outbox.types";
import type {
  ReplicationState,
  ReplicationStateUpdate,
  StoredReplicationDecision,
  ReplicationGuard,
  ReplicationImportPlan,
} from "../replication/replication.types";

/**
 * Техническая диагностика локального адаптера, без чтения файла из Core.
 */
export interface ProjectStorageInfo {
  /* Отображаемое расположение локального хранения; SQLite возвращает абсолютный путь. */
  readonly databasePath: string;
  /* Размер основного хранилища в байтах, без вспомогательных журналов. */
  readonly bytes: number;
}

/**
 * Синхронный порт локального предметного unit-of-work, без SQLite, файлов и жизненного цикла.
 * Реализация обязана объединять вложенные изменения и outbox в один outer commit.
 * Это контракт локального исполнения, не обещание синхронного сетевого PostgreSQL API.
 */
export interface ProjectStore {
  /* Постоянный ID выбранного проекта. */
  readonly projectId: string;
  /* Async I/O-порт загрузки проверяемого контекста и атомарного применения чистого command plan. */
  readonly commands: CommandStore;
  /**
   * Возвращает диагностику локального адаптера; не часть предметного снимка.
   */
  storageInfo(): ProjectStorageInfo;
  /**
   * В контексте записи отвергает переназначенный локально адрес без явной ожидаемой привязки.
   * Обычное чтение остаётся доступным; постоянные ID никогда не переназначаются.
   */
  assertWritableReference(ref: string): void;
  /**
   * Атомарно проверяет привязки и разрешает их только на время синхронного сценария.
   * ref уже очищен Core от kind:; callback проверяет виртуальные адреса своего предметного вида.
   */
  withReferenceGuards<T>(
    guards: readonly ExpectedEntityAddress[],
    operation: SynchronousOperation<T>,
  ): T;
  /**
   * Атомарно выполняет синхронный сценарий; вложенный отказ откатывает свою область.
   */
  transaction<T>(operation: SynchronousOperation<T>): T;
  /**
   * Читает согласованный снимок; callback не может возвращать Promise.
   */
  snapshot<T>(operation: SynchronousOperation<T>): T;
  /**
   * Читает сохранённую карточку с актуальным независимым журналом.
   */
  get(ref: string, kind?: EntityKind): EntityRecord | undefined;
  /**
   * Разрешает адрес без чтения содержания.
   */
  getIdentity(ref: string, kind?: EntityKind): EntityIdentity | undefined;
  /**
   * Читает выбранные постоянные ID в порядке запроса, пропуская отсутствующие.
   */
  getMany(ids: readonly string[], kind?: EntityKind): EntityRecord[];
  /**
   * Читает идентичности выбранных постоянных ID без полных карточек.
   */
  getManyIdentities(ids: readonly string[], kind?: EntityKind): EntityIdentity[];
  /**
   * Разрешает пакет адресов с null для отсутствующих.
   */
  resolveMany(refs: readonly string[]): (EntityIdentity | null)[];
  /**
   * Читает узкие проекции карточек в порядке постоянных ID.
   */
  getManySummaries(ids: readonly string[]): (EntitySummaryProjection | null)[];
  /**
   * Находит идентичности по точному slug/prefix внутри вида.
   */
  findAddressIdentities(ref: string, kind: EntityKind): EntityIdentity[];
  /**
   * Читает все сохранённые карточки выбранного вида либо проекта.
   */
  list(kind?: EntityKind): EntityRecord[];
  /**
   * Выбирает карточки по точному строковому полю верхнего уровня.
   */
  listByField(kind: EntityKind, field: string, value: string): EntityRecord[];
  /**
   * Выбирает идентичности и ревизии по строковому полю без содержания.
   */
  listIdentitiesByField(
    kind: EntityKind,
    field: string,
    value: string,
  ): EntityIdentityWithRevision[];
  /**
   * Проверяет присутствие адресованного элемента массива без загрузки карточки.
   */
  hasArrayItemByField(
    kind: EntityKind,
    arrayField: string,
    itemField: string,
    value: string,
  ): boolean;
  /**
   * Считает карточки без содержания.
   */
  count(kind?: EntityKind): number;
  /**
   * Возвращает SQL-окно и total из одного снимка.
   */
  listPage(kind: EntityKind, options: EntityPageRequest): EntityPage<EntityRecord>;
  /**
   * Читает узкие сохранённые обязательства всех задач без текстов и журналов.
   */
  listTaskGraph(): EntityRecord[];
  /**
   * Узкие raw-источники timeline/связей без Markdown и журналов; Core проверяет выбранные поля.
   * Сканирует metadata соответствующих owners/parts, не ограничивает размер проекта.
   */
  listGraphSources(view: "history" | "relations"): EntityRecord[];
  /**
   * Вставляет карточку и адреса, включая её в атомарный changeset внешней транзакции.
   */
  insert(entity: EntityRecord): void;
  /**
   * Выполняет CAS содержания, защищая неизменяемые поля и независимый журнал.
   */
  update(entity: EntityRecord, expectedRevision: number): void;
  /**
   * Резервирует следующий свободный адрес; rollback возвращает резервирование.
   */
  nextKey(prefix: string): string;
  /**
   * Дописывает неизменяемый комментарий, не меняя ревизию содержания.
   */
  appendTaskComment(ref: string, comment: Record<string, unknown>): EntityRecord;
  /**
   * Меняет ключ под CAS, сохраняет прежний алиас; no-op проверяет ревизию.
   */
  rename(id: string, key: string, expectedRevision: number, actor: string): EntityRecord;
  /**
   * Возвращает локальное поколение удерживаемого снимка.
   */
  getGeneration(): number;
  /**
   * Читает первоначальную пользовательскую квитанцию без актуализации результата.
   */
  getBatchReceipt(operationKey: string): StoredBatchReceipt | undefined;
  /**
   * Добавляет неизменяемую квитанцию атомарно с предметными изменениями.
   */
  insertBatchReceipt(receipt: StoredBatchReceipt): void;
}

/**
 * Порт доставки и согласования переносимого состояния, реализуемый локальным хранилищем.
 * Проверка предметных правил и доказательств acceptance принадлежит ReplicationService.
 */
export interface ReplicationStore extends ProjectStore {
  /**
   * Читает первичные scoped parts, включая tombstones, для выбранных owners либо полного снимка.
   */
  getComponents(ownerIds?: readonly string[]): PortableComponent[];
  /**
   * Читает скалярный guard локального commit без полного снимка.
   */
  getReplicationGuard(): ReplicationGuard;
  /**
   * Читает технический status ограниченными SQL-проекциями без payload очереди.
   */
  getReplicationStatus(): ReplicationStatus;
  /**
   * Читает точное сохранённое состояние без effective-проекций.
   */
  captureReplication(): PortableProjectSnapshot;
  /**
   * Возвращает техническое состояние реплики.
   */
  getReplicationState(): ReplicationState;
  /**
   * Читает весь durable outbox для явного полного local overlay/решения, не для выбора публикации.
   */
  getReplicationOutbox(): ReplicationChangeset[];
  /**
   * Ограничивает SQL-окно по числу/байтам до чтения payload; единичный oversized source неделим.
   */
  getReplicationOutboxWindow(request: ReplicationOutboxRequest): ReplicationOutboxWindow;
  /**
   * Читает исходные digest адресованного набора для сверки own proofs вне выбранного окна.
   */
  getReplicationOutboxDigests(ids: readonly string[]): ReplicationSourceDigest[];
  /**
   * Явно читает полный граф ID/dependencies для диагностики blocked, без выдачи source effects.
   */
  getReplicationOutboxDependencies(): ReplicationDependencySource[];
  /**
   * Читает конфликты, сохранённые последней подготовкой.
   */
  getReplicationConflicts(): ReplicationConflict[];
  /**
   * Читает fingerprint-защищённые пользовательские решения.
   */
  getReplicationDecisions(ids?: readonly string[]): StoredReplicationDecision[];
  /**
   * Атомарно сохраняет техническое состояние без echo-outbox.
   */
  updateReplicationState(update: ReplicationStateUpdate): void;
  /**
   * Применяет уже проверенный полный снимок строками, сохраняя локальные CAS и журналы.
   */
  importReplication(snapshot: PortableProjectSnapshot, plan?: ReplicationImportPlan): void;
  /**
   * Заполняет только специальную пустую реплику; существующая рабочая база отклоняется.
   */
  bootstrapReplication(snapshot: PortableProjectSnapshot): void;
}
