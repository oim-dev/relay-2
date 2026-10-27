/** Готовность сценария и вычисляемое состояние фичи. */
export const PRODUCT_STATUS = { NONE: "none", PARTIAL: "partial", DONE: "done" } as const;
/** Сценарии просмотра интерфейса на моковых данных. */
export const DEMO_MODE = {
  FILLED: "filled",
  EMPTY: "empty",
  NO_RESULTS: "no-results",
  LOADING: "loading",
  READ_ERROR: "read-error",
  SAVE_ERROR: "save-error",
} as const;
/** Подписи готовности фич и сценариев. */
export const PRODUCT_STATUS_OPTIONS = [
  { value: "none", label: "Не реализовано" },
  { value: "partial", label: "В работе" },
  { value: "done", label: "Реализовано" },
];
/** Назначения приложений. */
export const APPLICATION_TYPES = ["Фронтенд", "Бэкенд", "Внутренний инструмент"];
/** Варианты для проверки состояний раздела. */
export const DEMO_MODE_OPTIONS = [
  { value: "filled", label: "Заполненный раздел" },
  { value: "empty", label: "Пустой раздел" },
  { value: "no-results", label: "Нет результатов поиска" },
  { value: "loading", label: "Загрузка" },
  { value: "read-error", label: "Ошибка чтения" },
  { value: "save-error", label: "Ошибка сохранения" },
];
