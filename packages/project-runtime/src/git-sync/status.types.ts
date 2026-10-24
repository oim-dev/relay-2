/**
 * Один независимый исход регистрации workspace; ошибка не исключает последующие регистрации.
 */
export type GitSyncWorkspaceItem = {
  /* Имя регистрации workspace, а не предметное имя проекта. */
  readonly name: string;
  /* Абсолютный каталог конфигурации проекта. */
  readonly path: string;
} & (
  | {
      /* Доступный проект с ответом компонента. */
      readonly ok: true;
      /* Статус проекта в переносимой форме Git Sync. */
      readonly data: unknown;
    }
  | {
      /* Недоступный проект либо отказ обновления remote. */
      readonly ok: false;
      /* Структурированная причина только этой регистрации. */
      readonly error: {
        /* Стабильный код отказа. */
        readonly code: string;
        /* Диагностика для человека. */
        readonly message: string;
        /* Код завершения компонента. */
        readonly exitCode: number;
        /* Дополнительные сведения без подмены исходного отказа. */
        readonly details?: Readonly<Record<string, unknown>>;
      };
    }
);

/**
 * Все регистрации workspace, включая недоступные, в порядке конфигурации.
 */
export interface GitSyncWorkspaceStatus {
  /* Версия пользовательской формы статуса; одиночный CLI-ответ использует ту же оболочку items. */
  readonly version: 1;
  /* Отличает агрегат от ответа одного проекта. */
  readonly scope: "workspace";
  /* Полный набор регистраций без пагинации. */
  readonly items: readonly GitSyncWorkspaceItem[];
}
