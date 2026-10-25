import type { HttpError } from "./http.types";

/**
 * Стабильная Web-проекция cached Runtime status. Null означает неизвестное, а не ноль.
 * Сервер не выполняет Git и не инициирует refresh при чтении этого результата.
 */
export interface HttpGitSyncStatus {
  /* Подключение к общей ветке; null при неизвестном состоянии. */
  readonly connected: boolean | null;
  /* Режим фонового обмена либо неизвестное состояние. */
  readonly mode: "manual" | "auto" | null;
  /* Текущая фаза, без вывода живости из сохранённой busy-фазы. */
  readonly phase: string | null;
  /* Живость отдельного worker. */
  readonly worker: {
    /* Желаемое состояние пользователя. */
    readonly desired: "running" | "stopped" | null;
    /* Результат health-проверки, а не PID-эвристика. */
    readonly actual: "running" | "stopped" | "unknown";
    /* Подтверждённый отклик либо неизвестно. */
    readonly responsive: boolean | null;
  };
  /* Локальные changeset не равны ahead/behind Git. */
  readonly pending: {
    /* Все неподтверждённые изменения либо неизвестно. */
    readonly changesets: number | null;
    /* Не включённые в Git-кандидат либо неизвестно. */
    readonly unexported: number | null;
  };
  /* Диагностика реальных конфликтов и её актуальность. */
  readonly conflicts: {
    /* Число конфликтов либо неизвестно. */
    readonly count: number | null;
    /* Неполная проверка сохраняет partial, неизвестное — unknown. */
    readonly freshness: "current" | "stale" | "partial" | "unknown";
    /* Время пересчёта ISO либо null. */
    readonly asOf: string | null;
  };
  /* Время успешного обмена ISO либо null. */
  readonly lastSuccess: string | null;
  /* Последняя ошибка Runtime/обмена; null после успеха либо до первой попытки. */
  readonly error: HttpError | null;
  /* Актуальность сведений об общей ветке. */
  readonly freshness: {
    /* Были ли получены сведения fetch. */
    readonly known: boolean | null;
    /* Время последнего fetch ISO либо null. */
    readonly asOf: string | null;
    /* Известный HEAD общей ветки либо null. */
    readonly remoteHead: string | null;
  };
}
