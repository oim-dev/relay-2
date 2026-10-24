/**
 * Имена CLI-параметров локального и переносимого предусловий одного владельца.
 */
export interface VersionFlagPair {
  /* Числовая локальная CAS-ревизия, например if-revision или target-revision. */
  readonly revision: string;
  /* Непрозрачный aggregateVersion того же владельца. */
  readonly version: string;
}

/**
 * Проверенные CLI-значения без чтения владельца и без подстановки текущей ревизии.
 */
export interface ParsedVersionPrecondition {
  /* Исходная локальная ревизия; отсутствие оставляет только переносимое предусловие. */
  readonly ifRevision?: number;
  /* Дословный переносимый токен пользователя; отсутствие оставляет локальный CAS. */
  readonly expectedVersion?: string;
}
