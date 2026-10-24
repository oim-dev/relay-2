import type {
  BatchResult,
  KnowledgeRecord,
  PortableBatchReceipt,
  PortableProjectSnapshot,
  ReplicationChangeset,
  TaskComment,
  TaskRecord,
} from "@relay/contracts";

/**
 * Исходные пользовательские результаты offline-создания; ID не берутся из позднего remote.
 */
export interface OfflineCreation {
  /* Номер участника, используемый только в воспроизводимых предметных значениях. */
  readonly index: number;
  /* Документ с предварительным ключом и точным исходным Markdown. */
  readonly document: KnowledgeRecord<"document">;
  /* Собственная задача — цель ссылки документа; её ключ также может перенумероваться. */
  readonly task: TaskRecord;
  /* Исходные immutable changeset до первого обмена. */
  readonly changesets: readonly ReplicationChangeset[];
}

/**
 * Ожидаемые эффекты второй волны и исходная квитанция связанного атомарного пакета.
 */
export interface IndependentWork {
  /* Уникальный для участника ключ пользовательской операции. */
  readonly operationKey: string;
  /* Первоначальный результат до обмена и позднейшего изменения записей. */
  readonly result: BatchResult;
  /* Дословный request/result из сохранённой квитанции, не пересчитанная проекция. */
  readonly receipt: PortableBatchReceipt;
  /* Комментарий, выданный локальной командой: ID, авторство и тело должны сохраниться. */
  readonly comment: TaskComment;
  /* Три атомарные транзакции: точечная правка, комментарий, связанный batch. */
  readonly changesets: readonly ReplicationChangeset[];
}

/**
 * Итог разрешённой причинной цепочки с сохранением первоначальной конфликтной квитанции.
 */
export interface ResolvedWork {
  /* Все исходные изменения обоих участников, включая независимую позднюю запись. */
  readonly changesets: readonly ReplicationChangeset[];
  /* Неизменяемый результат конфликтного пакета, выданный до публикации. */
  readonly result: BatchResult;
  /* Operation key именно пользовательского пакета, а не changeset или ack. */
  readonly operationKey: string;
}

/**
 * Предметное portable-состояние без транспортного конверта последней публикации.
 * Конверт проверяется по реальной Git-цепочке; локальный capture по контракту имеет publication:null.
 */
export type CanonicalTeamState = Omit<PortableProjectSnapshot, "publication">;
