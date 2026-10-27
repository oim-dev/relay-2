/**
 * Явное восстановление неопределённой записи независимо от исходной формы.
 */
export interface WriteRecoveryProps {
  /* Постоянный ID проекта, отделяющий уведомления разных областей. */
  readonly projectId: string;
  /* Отображаемое имя проекта текущего каркаса. */
  readonly projectName: string;
}

/**
 * Эффекты одного явного recovery-действия существующего уведомления.
 * Они привязаны к исходным projectId/operationKey и экземпляру каркаса.
 */
export interface WriteRecoveryEffects {
  /* false после ухода из исходного экземпляра проекта; GET-кеш всё равно обновляется по его ID. */
  readonly isActive: () => boolean;
  /* Очищает локальную ошибку только для действительно актуального нажатия. */
  readonly started: () => void;
  /* Инвалидирует только GET-ключи, выбранные переданным предикатом. */
  readonly refresh: (matches: (key: unknown) => boolean) => Promise<unknown>;
  /* Подтверждение исходной операции; не должно закрывать уведомление более новой pending. */
  readonly confirmed: () => void;
  /* Достоверный отказ исходной операции, после которого writer уже снял блокировку. */
  readonly rejected: (message: string) => void;
  /* Неопределённость той же операции; повтор по её ключу остаётся доступным. */
  readonly uncertain: (message: string) => void;
}

/**
 * Локальная диагностика, которую нельзя показывать вместо ошибки другой pending-операции.
 */
export interface WriteRecoveryFailure {
  /* Ключ операции, вернувшей ошибку. */
  readonly operationKey: string;
  /* Исходная диагностика writer/SDK. */
  readonly message: string;
}
