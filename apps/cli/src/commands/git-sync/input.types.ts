/**
 * Два независимых источника восстановления: Git snapshot либо сохранённое локальное намерение.
 */
export type GitSyncRestoreInput =
  | {
      /* Явное завершение существующего intent без materializer/fetch. */
      readonly resume: true;
      /* Постоянный ID; отсутствие поручает Runtime выбрать его из существующего config. */
      readonly projectId?: string;
      /* Новый Git-источник при resume не принимается. */
      readonly remote?: never;
      /* Новая ветка при resume не принимается. */
      readonly branch?: never;
    }
  | {
      /* Обычный restore не включает режим resume, в том числе при явном --resume=false. */
      readonly resume?: never;
      /* Постоянный ID без resume не является источником нового snapshot. */
      readonly projectId?: never;
      /* Явный Git remote; отсутствие сохраняет прежний выбор сохранённого подключения. */
      readonly remote?: string;
      /* Явная ветка данных; отсутствие сохраняет default компонента. */
      readonly branch?: string;
    };
/**
 * Управление только ожиданием явного network-запроса; ID нового submit выделяет Runtime.
 */
export interface GitSyncWaitInput extends Readonly<Record<string, unknown>> {
  /* ID прежнего запроса; наличие запрещает новый submit. */
  readonly requestId?: string;
  /* Budget ожидания в миллисекундах, 1..90000; отсутствие выбирает default компонента 60000. */
  readonly waitMs?: number;
}
