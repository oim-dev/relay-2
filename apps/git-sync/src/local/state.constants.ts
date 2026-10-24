/**
 * Фазы локального транспорта; порядок не является машиной состояний предметной репликации.
 */
export const SYNC_PHASES = [
  "idle",
  "waiting",
  "fetching",
  "validating",
  "preparing",
  "committing",
  "pushing",
  "outcome-unknown",
  "accepting",
  "retrying",
  "error",
] as const;

/**
 * Общая ветка нового подключения/восстановления при отсутствии явного имени.
 */
export const DEFAULT_DATA_BRANCH = "relay-data-v2";
