import type { ReplicationResolutionMaterial } from "./replication.types";

/**
 * Явная замена нового назначения в исходной ленте; постоянный ID и содержание не меняются.
 * Последующий исходный rename выполняется обычно: заменённый промежуточный ключ становится alias.
 */
export interface ReplicationKeyAssignment {
  /* Постоянный ID владельца проигравшего неопубликованного назначения. */
  readonly entityId: string;
  /* Столкнувшийся исходный ключ; можно опустить только при единственной коллизии этого ID. */
  readonly fromKey?: string;
  /* Выбранный свободный ключ; для числового ключа сохраняется исходный префикс. */
  readonly key: string;
}

/**
 * Отдельный Core-ввод разрешения всех коллизий ключей одного атомарного changeset.
 * Не выбирает сторону конфликта содержимого и не изменяет первоначальные source/receipt.
 */
export interface ReplicationKeyDecision {
  /* Отпечаток из keyConflicts(), проверяемый перед сохранением решения. */
  readonly fingerprint: string;
  /* Уникальные пары entityId/fromKey и выбранные ключи; при нескольких коллизиях ID fromKey обязателен. */
  readonly assignments: readonly ReplicationKeyAssignment[];
}

/**
 * Неизменяемое переносимое решение адресации, отдельное от серверного ввода local/remote/custom.
 */
export interface ReplicationKeyResolution
  extends ReplicationKeyDecision, ReplicationResolutionMaterial {
  /* Выбирает только новое назначение ключа; остальные эффекты проходят обычное согласование. */
  readonly choice: "keys";
}

/**
 * Два разных постоянных ID претендуют на один читаемый ключ.
 */
export interface ReplicationKeyCollision {
  /* Постоянный ID владельца локального непринятого назначения. */
  readonly entityId: string;
  /* Столкнувшееся новое назначение любой исходной boundary; передаётся как assignment.fromKey. */
  readonly key: string;
  /* Постоянный ID владельца адреса, уже принятого общей историей. */
  readonly acceptedOwnerId: string;
  /* Свободный на момент чтения ключ; предложение не резервирует адрес. */
  readonly suggestedKey: string;
}

/**
 * Адресная диагностика Core для CLI; прежние серверные DTO конфликтов не расширяются.
 */
export interface ReplicationKeyConflict {
  /* ID целого конфликтующего changeset. */
  readonly id: string;
  /* Отпечаток последнего prepare/accept; resolve заново проверяет его актуальность. */
  readonly fingerprint: string;
  /* Причина коллизии либо непринятого позднего решения. */
  readonly code: "REPLICATION_KEY_COLLISION" | "REPLICATION_RESOLUTION_STALE";
  /* Русское описание причины. */
  readonly message: string;
  /* Все столкнувшиеся ключи этого changeset; пусто при уже принятом другом решении. */
  readonly collisions: readonly ReplicationKeyCollision[];
  /* Позднее ключевое решение при уже принятом другом результате; иначе отсутствует. */
  readonly pendingResolution?: ReplicationKeyResolution;
  /* Принятое решение при REPLICATION_RESOLUTION_STALE; null означает обычное согласование. */
  readonly acceptedResolutionId?: string | null;
}
