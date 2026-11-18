import type {
  PortableProjectSnapshot,
  ReplicationConflict,
  PortableReplicationResolution,
  ReplicatedEntityChange,
  PortableComponent,
  PortableComment,
  PortableBatchReceipt,
  PortableAddress,
  ReplicationPublication,
} from "@relay/contracts";

/**
 * Локальное состояние обмена; не экспортируется в общий снимок.
 */
export interface ReplicationState {
  /* Постоянный ID текущей SQLite-реплики. */
  readonly replicaId: string;
  /* Последний выделенный номер атомарной транзакции. */
  readonly sequence: number;
  /* Версия локального состояния обмена и импорта, включая current proof и receipt-only. */
  readonly revision: number;
  /* Последний реально принятый remote либо null до первого обмена. */
  readonly base: PortableProjectSnapshot | null;
  /* Последний предъявленный prepare снимок для защищённого решения конфликта. */
  readonly observed: PortableProjectSnapshot | null;
}

/**
 * Сохранённое решение пользователя относительно одной версии конфликта.
 */
export type StoredReplicationDecision = PortableReplicationResolution & {
  /* ID changeset, к которому относится решение. */
  readonly id: string;
  /* Локальный immutable witness исходного наложения; не входит в переносимое решение. */
  readonly localSources?: readonly ResolutionLocalSource[];
};

/**
 * Неизменяемые составляющие локального наложения при просмотре решения, без local CAS.
 */
export interface ResolutionLocalSource {
  /* ID неподтверждённого changeset, меняющего просмотренную область. */
  readonly id: string;
  /* Digest его неизменённого payload. */
  readonly digest: string;
  /* Выбранное решение этой мутации либо null. */
  readonly resolutionId: string | null;
}

/**
 * Атомарная запись служебного состояния после проверки Core.
 * currentPublication связывается с текущими переносимыми строками только под тем же guard,
 * что импорт/accept; base независимо сохраняет последний принятый checkpoint.
 * Изменение переносимых строк снимает прежнюю привязку даже без явного currentPublication.
 */
export interface ReplicationStateUpdate {
  /* Реально принятый remote; отсутствие оставляет прежнюю базу. */
  readonly base?: PortableProjectSnapshot;
  /* Проверенный proof текущих строк; null снимает его, undefined не назначает новый. */
  readonly currentPublication?: ReplicationPublication | null;
  /* Предъявленный prepare снимок; null обозначает ещё пустую общую ветку. */
  readonly observed?: PortableProjectSnapshot | null;
  /* Актуальные конфликты examined либо полный набор при отсутствии examined. */
  readonly conflicts: readonly ReplicationConflict[];
  /* Рассмотренные ID ограниченной подготовки; остальные материалы остаются без изменений. */
  readonly examined?: readonly string[];
  /* Только доказанно подтверждённые ID локальных changeset. */
  readonly acknowledged?: readonly string[];
  /* Новое пользовательское решение; отсутствие ничего не добавляет. */
  readonly decision?: StoredReplicationDecision;
}

/**
 * SQL-строка транзакционной очереди; JSON создан адаптером typed записи из raw-проекций.
 */
export interface EntityDeltaRow {
  /* Постоянный ID затронутой карточки. */
  readonly id: string;
  /* Исходный JSON либо null при создании. */
  readonly before_json: string | null;
  /* Конечный JSON либо null при удалении. */
  readonly after_json: string | null;
}

/**
 * Строка служебного JSON, созданная владельцем Storage/Core.
 */
export interface ReplicationJsonRow {
  /* Точная сериализация проверенной структуры. */
  readonly json: string;
}

/**
 * Первичная переносимая строка подтверждений одной реплики.
 */
export interface ReplicationConfirmationRow {
  /* Постоянный ID подтверждаемой реплики. */
  readonly replica_id: string;
  /* Точные диапазоны подтверждённых sequence. */
  readonly ranges_json: string;
  /* Точные публикационные proofs; SQL null сохраняет отсутствие optional поля. */
  readonly proofs_json: string | null;
}

/**
 * Узкие адресные пространства для диагностики коллизий без содержания владельцев и очереди.
 */
export interface ReplicationKeyAddresses {
  /* Действующие локальные ID, ключи и исторические aliases в порядке ref. */
  readonly local: readonly PortableAddress[];
  /* Адреса последнего observed snapshot в порядке ref; пусто при его отсутствии. */
  readonly observed: readonly PortableAddress[];
  /* Выбранные ключи последних решений ещё неподтверждённых sources; предложения должны их учитывать. */
  readonly pending: readonly PortableAddress[];
}

/**
 * Переносимая версия сохранённой карточки, независимая от локальной ревизии.
 */
export interface StoredEntityVersion {
  /* Непрозрачный SHA-256 ID версии. */
  readonly version: string;
  /* Канонический JSON массива непосредственно предшествующих версий. */
  readonly parents_json: string;
}

/**
 * Узкий курсор записи без чтения/декодирования полного base snapshot на каждом write.
 */
export interface ReplicationCursorRow {
  /* Постоянный ID локальной реплики. */
  readonly replica_id: string;
  /* Последний выделенный номер изменений. */
  readonly sequence: number;
  /* Постоянный ID проекта. */
  readonly project_id: string;
}

/**
 * Сырая строка локального состояния реплики.
 */
export interface ReplicationStateRow {
  /* ID этой реплики. */
  readonly replica_id: string;
  /* Последний выделенный номер. */
  readonly sequence: number;
  /* Локальная версия технического состояния обмена. */
  readonly revision: number;
  /* Последний принятый remote, сериализованный Core. */
  readonly base_json: string | null;
  /* Последний предъявленный снимок, не являющийся ack локальной очереди. */
  readonly observed_json: string | null;
}

/**
 * Узкий guard атомарного commit без декодирования полного принятого снимка.
 */
export interface ReplicationGuard {
  /* Постоянный ID локальной реплики. */
  readonly replicaId: string;
  /* Последний номер локального changeset. */
  readonly sequence: number;
  /* Версия состояния обмена и импорта, включая решения, квитанции и current proof. */
  readonly revision: number;
  /* Поколение предметного состояния. */
  readonly generation: number;
}

/**
 * Чисто рассчитанный sparse import, применяемый только после проверки ReplicationGuard в Core.
 */
export interface ReplicationImportPlan {
  /* Постоянный ID проекта; план не переносится между хранилищами. */
  readonly projectId: string;
  /* Только изменённые владельцы; изменение части также повышает локальный CAS владельца. */
  readonly entities: readonly ReplicatedEntityChange[];
  /* Только новые или изменённые первичные parts. */
  readonly componentUpserts: readonly PortableComponent[];
  /* Только отвергнутые локальные части, отсутствующие в кандидате; canonical tombstones сохраняются. */
  readonly componentRemovals: readonly PortableComponent[];
  /* Добавления неизменяемого журнала без замены существующих ID. */
  readonly commentsAdded: readonly PortableComment[];
  /* Отвергнутые неопубликованные комментарии. */
  readonly commentsRemoved: readonly PortableComment[];
  /* Новый causal порядок только затронутых журналов; пустой ids очищает удалённую ветвь. */
  readonly commentOrder: readonly { readonly taskId: string; readonly ids: readonly string[] }[];
  /* Новые точные пользовательские квитанции; существующие не обновляются. */
  readonly receiptsAdded: readonly PortableBatchReceipt[];
  /* Утратившие прежнего владельца provisional refs для защиты старого ввода. */
  readonly remapped: readonly {
    readonly ref: string;
    readonly previousId: string;
    readonly currentId: string;
  }[];
}

/**
 * Узкие метаданные владельца для переносимого aggregate guard, без чтения его тела.
 */
export interface PortableAggregateRoot {
  /* Только постоянный ID владельца; полная PortableEntity структурно совместима. */
  readonly record: { readonly id: string };
  /* Уже сохранённая primary версия, без повторного self-hash record. */
  readonly version: string;
}

/**
 * Узкие метаданные независимо версионируемой части, без value/Markdown/локальной ревизии.
 */
export type PortableAggregatePart = Pick<PortableComponent, "ownerId" | "kind" | "id" | "version">;

/**
 * Узкая согласованная SQL-метаинформация прочитанных/изменённых владельцев одной command boundary.
 */
export interface TransitionReadMetadata {
  /* Постоянный ID из адресного набора команды. */
  readonly id: string;
  /* Primary версия с учётом предыдущих шагов того же batch либо null при новом ID. */
  readonly version: string | null;
  /* Parents той же версии; null при новом ID. */
  readonly parents_json: string | null;
  /* Точная raw SQL сторона до первой команды над owner; null у создания или следующих границ. */
  readonly before_json: string | null;
  /* Последний внешний changeset содержания либо null. */
  readonly content_source: string | null;
  /* Changeset создания ID либо null. */
  readonly existence_source: string | null;
}

/**
 * Одно SQL-событие части после предыдущей границы; schema запрещает physical delete обычной командой.
 */
export interface TransitionComponentEvent {
  /* Локальный порядок SQL-события, не экспортируется. */
  readonly sequence: number;
  /* Предыдущее точное переносимое значение либо null при создании. */
  readonly before_json: string | null;
  /* Новое точное переносимое значение, включая tombstone. */
  readonly after_json: string;
}
