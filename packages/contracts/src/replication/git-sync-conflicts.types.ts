import type { ReplicationConflict } from "./replication.types";

/**
 * Краткие материалы действительного конфликта; fingerprint адресует согласование сторон через resolve.
 */
export type GitSyncConflictSummary = Pick<
  ReplicationConflict,
  "id" | "fingerprint" | "code" | "message"
>;

/**
 * Pending changeset, ожидающий принятия предшественников. Fingerprint и решение сторон отсутствуют.
 */
export interface GitSyncBlockedChangeset {
  /* Постоянный ID ожидающего changeset. */
  readonly id: string;
  /* Ожидание в durable outbox, не трёхсторонний конфликт. */
  readonly state: "pending";
  /* Машинная причина ожидания dependencies. */
  readonly code: "REPLICATION_DEPENDENCY";
  /* Объяснение причины ожидания для человека. */
  readonly message: string;
  /* Непосредственные source IDs, ещё не принятые в наблюдаемой общей ветке. */
  readonly dependencies: readonly string[];
}

/**
 * Полная явная диагностика conflicts.list, отдельно от bounded подготовки и обычного status.
 */
export interface GitSyncConflictList {
  /* Все сохранённые действительные конфликты; пустой список не означает пустой outbox. */
  readonly conflicts: readonly GitSyncConflictSummary[];
  /* Все ожидающие dependencies changeset с непосредственными причинами. */
  readonly blocked: readonly GitSyncBlockedChangeset[];
}

/**
 * conflicts.get возвращает полные стороны действительного конфликта либо причину pending-ожидания.
 */
export type GitSyncConflictDetails = ReplicationConflict | GitSyncBlockedChangeset;

/**
 * Итог сохранения решения: included только подготовлены, а pending ещё не подтверждён Git.
 */
export interface GitSyncConflictResolutionResult extends GitSyncConflictList {
  /* Постоянный ID changeset, для которого сохранено решение. */
  readonly id: string;
  /* Поколение Core, на котором проверено решение. */
  readonly generation: number;
  /* ID готовых к следующей публикации changeset ограниченного preview. */
  readonly included: readonly string[];
  /* Фактическое число всех неподтверждённых локальных changeset после сохранения решения. */
  readonly pending: number;
  /* ID preview-окна, ожидавшие dependencies при подготовке. */
  readonly deferred: readonly string[];
  /* Есть более поздние changeset за пределами подготовленного preview. */
  readonly hasMore: boolean;
}
