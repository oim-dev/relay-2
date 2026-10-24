/**
 * Версионированный процессный запрос CLI к бинарнику Git Sync.
 * input проверяет владелец конкретного action до предметного вызова Core.
 */
export interface GitSyncRequest {
  /* Версия процессного протокола. */
  readonly version: 1;
  /* Имя действия, проверяемое реестром Git Sync. */
  readonly action: string;
  /* Параметры выбора локального проекта, без секретов транспорта. */
  readonly options: {
    /* Рабочий каталог вызывающего процесса. */
    readonly cwd: string;
    /* Явный путь конфигурации; отсутствие включает обычный выбор. */
    readonly config?: string;
    /* Явный RELAY_HOME; отсутствие использует настройку окружения. */
    readonly home?: string;
    /* Имя проекта workspace; отсутствие выбирает локальный проект. */
    readonly project?: string;
  };
  /* Непроверенные параметры выбранного действия; отсутствие означает пустой ввод. */
  readonly input?: Record<string, unknown>;
}

/**
 * Единственный JSON-ответ процесса; диагностический stderr не входит в протокол.
 */
export type GitSyncResponse =
  | {
      /* Версия процессного протокола. */
      readonly version: 1;
      /* Дискриминатор успешного ответа. */
      readonly ok: true;
      /* Результат действия, схема которого принадлежит Git Sync. */
      readonly data: unknown;
    }
  | {
      /* Версия процессного протокола. */
      readonly version: 1;
      /* Дискриминатор отказа. */
      readonly ok: false;
      /* Стабильная диагностика действия. */
      readonly error: {
        /* Машинный код ошибки. */
        readonly code: string;
        /* Русское сообщение для человека. */
        readonly message: string;
        /* Код завершения процесса. */
        readonly exitCode: number;
        /* Дополнительные структурированные сведения при наличии. */
        readonly details?: Readonly<Record<string, unknown>>;
      };
    };
