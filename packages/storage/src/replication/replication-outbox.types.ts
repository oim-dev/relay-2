import type { ReplicationChangeset } from "@relay/contracts";

/**
 * Ограниченное индексное окно исходных транзакций; вызывающий владеет курсором обхода.
 * Одиночный changeset больше maxBytes возвращается целиком и один, без дробления транзакции.
 */
export interface ReplicationOutboxRequest {
  /* Исключительная нижняя граница локального sequence; 0 начинает новый обход. */
  readonly afterSequence: number;
  /* Положительный максимальный размер окна по числу исходных changeset. */
  readonly maxChangesets: number;
  /* Положительный бюджет UTF-8 байтов сохранённых JSON payload, включая их digest. */
  readonly maxBytes: number;
}

/**
 * Согласованное окно без декодирования остальной очереди; это ещё не готовая публикация.
 */
export interface ReplicationOutboxWindow {
  /* Неизменённые sources в возрастающем порядке локального sequence. */
  readonly changesets: readonly ReplicationChangeset[];
  /* Точное число байтов возвращённых JSON sources. */
  readonly sourceBytes: number;
  /* true только для одного атомарного source, превышающего бюджет байтов. */
  readonly oversized: boolean;
  /* Есть следующий source после окна; подтверждённость и dependencies проверяет Core. */
  readonly hasMore: boolean;
  /* Последний просмотренный sequence либо 0 при достижении конца обхода. */
  readonly nextSequence: number;
  /* Полное число неподтверждённых sources в том же снимке, включая окно. */
  readonly pending: number;
}

/**
 * Узкая исходная идентичность для сверки remote proofs вне текущего окна.
 */
export type ReplicationSourceDigest = Pick<
  ReplicationChangeset,
  "id" | "replicaId" | "sequence" | "digest"
>;

/**
 * Узкий граф причинной очереди для явной диагностики pending, без source effects/текстов.
 */
export type ReplicationDependencySource = Pick<ReplicationChangeset, "id" | "dependencies">;

/**
 * Сериализованные зависимости из SQL-проекции диагностического чтения.
 */
export interface ReplicationDependencyRow {
  /* ID исходного changeset. */
  readonly id: string;
  /* JSON только массива непосредственных source dependencies. */
  readonly dependenciesJson: string;
}

/**
 * SQL-метаданные индексного окна, не требующие разбора JSON payload.
 */
export interface ReplicationOutboxSizeRow {
  /* Первичный ключ исходного changeset. */
  readonly id: string;
  /* Локальный индекс очереди. */
  readonly sequence: number;
  /* UTF-8 длина сохранённого JSON. */
  readonly bytes: number;
}
