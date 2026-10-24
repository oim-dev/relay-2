/**
 * Переносимое дерево Git; пути проверены codec, содержимое хранится без нормализации строк.
 */
export type GitFiles = ReadonlyMap<string, Uint8Array>;

/**
 * Проверенный непосредственный Git-parent одной canonical публикации.
 */
export interface GitHistoryEntry {
  /* Commit ID реального Git object, не publicationId предметной модели. */
  readonly head: string;
  /* Единственный непосредственный родитель; null допустим только у genesis. */
  readonly parent: string | null;
}

/**
 * Параметры одного независимого частного bare-репозитория.
 */
export interface RepositoryOptions {
  /* Абсолютный каталог частного bare-репозитория вне code checkout. */
  readonly directory: string;
  /* Зафиксированный URL либо абсолютный локальный путь стандартного Git remote. */
  readonly remote: string;
  /* Единственная общая ветка данных, без refs/heads/. */
  readonly branch: string;
  /* Отмена всего текущего сетевого цикла. */
  readonly signal?: AbortSignal;
  /* Deadline одной Git-команды в миллисекундах. */
  readonly timeoutMs?: number;
  /* Дополнения окружения только Git-процессов данного контекста; процесс вызывающего не изменяется. */
  readonly env?: Readonly<Record<string, string | undefined>>;
}

/**
 * Настоящие Git-счётчики относительно последнего проверенного remote head.
 */
export interface GitCounts {
  /* Проверенный локальный ref последнего кандидата/приёма, null до первого. */
  readonly localHead: string | null;
  /* Последний проверенный remote head, null до появления общей ветки. */
  readonly remoteHead: string | null;
  /* Число локальных коммитов вне remote; null, когда одна из сторон неизвестна. */
  readonly ahead: number | null;
  /* Число remote-коммитов вне локальной стороны; null при неизвестной стороне. */
  readonly behind: number | null;
}
