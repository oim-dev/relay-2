import type { PreparedReplication, ReplicationChangeset } from "@relay/contracts";

/**
 * Конечный бюджет исходных атомарных changeset одной подготовки.
 * Source больше байтового бюджета допускается только один; snapshot и effective tape имеют отдельную стоимость.
 */
export interface ReplicationPublicationBudget {
  /* Максимальное число рассматриваемых sources; default 64, допускается уменьшение. */
  readonly maxChangesets: number;
  /* Бюджет UTF-8 JSON sources; default 8 MiB, допускается уменьшение. */
  readonly maxBytes: number;
}

/**
 * Управление ограниченным обходом outbox; курсор сохраняется транспортом между попытками.
 */
export interface ReplicationPrepareOptions {
  /* Последний просмотренный sequence; default 0. При non-FF повторяется исходный курсор попытки. */
  readonly afterSequence?: number;
  /* Меньший явный бюджет; пропущенные поля получают конечные defaults. */
  readonly budget?: Partial<ReplicationPublicationBudget>;
}

/**
 * Прогресс именно выбора, не подтверждение отправки очереди.
 * nextSequence продвигается после установленного исхода публикации либо окна без included.
 * hasMore=false означает конец обхода, а pending по-прежнему может быть положительным.
 */
export interface ReplicationPublicationSelection {
  /* Исходный курсор этой попытки; сохраняется при non-FF/неизвестном исходе push. */
  readonly afterSequence: number;
  /* Следующий курсор либо 0 для начала нового обхода. */
  readonly nextSequence: number;
  /* Есть более поздние sources за выбранным окном. */
  readonly hasMore: boolean;
  /* Точные рассмотренные ID в локальном причинном порядке. */
  readonly examined: readonly string[];
  /* Рассмотренные ID, ожидающие зависимости; не ack и не конфликт. */
  readonly deferred: readonly string[];
  /* Точная причина ожидания каждого deferred ID на его шаге подготовки. */
  readonly waiting: readonly ReplicationDependencyWait[];
  /* Все неподтверждённые sources согласованного контекста, включая included до реального accept. */
  readonly pending: number;
  /* Число прочитанных UTF-8 байтов исходных JSON без canonical snapshot и diagnostics. */
  readonly sourceBytes: number;
  /* true только у одного неделимого source больше byte budget. */
  readonly oversized: boolean;
}

/**
 * Ограниченная публикация; conflicts относятся только к examined, полный журнал доступен через conflicts().
 */
export interface BoundedPreparedReplication extends PreparedReplication {
  /* Явный прогресс очереди, сохраняющий различие конца окна и конца всех pending effects. */
  readonly selection: ReplicationPublicationSelection;
}

/**
 * Внутренний результат merge с материалом отложенного local overlay, не транспортный ack.
 */
export interface PendingReplicationPreparation extends PreparedReplication {
  /* Целые источники, для которых ещё не приняты зависимости. */
  readonly deferred: readonly ReplicationChangeset[];
  /* Непринятые непосредственные зависимости каждого deferred source. */
  readonly waiting: readonly ReplicationDependencyWait[];
}

/**
 * Ожидание причинного предшественника; это pending, не конфликт и не подтверждение source.
 * Непосредственные dependencies связывают строки в заблокированные цепочки без полного payload.
 */
export interface ReplicationDependencyWait {
  /* ID целого ожидающего changeset. */
  readonly id: string;
  /* Состояние очереди, требующее принятия предшественников. */
  readonly state: "pending";
  /* Стабильная причина, не требующая распознавания текста. */
  readonly code: "REPLICATION_DEPENDENCY";
  /* Русское объяснение причины ожидания. */
  readonly message: string;
  /* Точные непосредственные source ID, ещё не принятые на указанном шаге/observed snapshot. */
  readonly dependencies: readonly string[];
}
