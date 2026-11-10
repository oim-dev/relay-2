import type { ProcessInput, ProcessResult } from "./process.types";

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
 * Параметры транспорта одной реплики; отсутствие worktree сохраняет legacy bare и restore staging.
 */
export interface RepositoryOptions {
  /* Абсолютный каталог служебного worktree либо legacy bare-репозитория. */
  readonly directory: string;
  /* Связь с репозиторием кода; undefined предназначен для legacy и private staging restore. */
  readonly worktree?: DataWorktree;
  /* Приватные транспортные метаданные вне checkout; undefined использует соседний state либо legacy bare. */
  readonly stateDirectory?: string;
  /* Зафиксированный URL либо абсолютный локальный путь стандартного Git remote. */
  readonly remote: string;
  /* Единственная общая ветка данных, без refs/heads/. */
  readonly branch: string;
  /* Отмена владельца, действующая также при инициализации вне сетевого attempt. */
  readonly signal?: AbortSignal;
  /* Deadline одной Git-команды в миллисекундах. */
  readonly timeoutMs?: number;
  /* Дополнения окружения только Git-процессов данного контекста; процесс вызывающего не изменяется. */
  readonly env?: Readonly<Record<string, string | undefined>>;
}

/**
 * Владелец linked worktree и namespace технических refs, отдельный от веток исходного кода.
 * Одна локальная ветка данных может принадлежать только одному worktree в общем Git common-dir.
 * Вызывающий сериализует операции реплики; параллельные ручные изменения checkout не допускаются.
 */
export interface DataWorktree {
  /* Git-якорь: common-dir либо каталог проекта; настройки наследуются из общего репозитория. */
  readonly projectDirectory: string;
  /* Проверенная идентичность common-dir; разрешает repair после rename репозитория кода без переноса data. */
  readonly commonDirectoryIdentity?: string;
  /* Постоянный ID проекта; маркер worktree сохраняет владение при восстановлении новой SQLite-реплики. */
  readonly projectId: string;
  /* Постоянный ID локальной SQLite-реплики, проверенный Storage. */
  readonly replicaId: string;
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
/**
 * Git-вызов в явном каталоге с общими deadline, окружением и отменой владельца/attempt.
 */
export type RepositoryGitExecution = (
  directory: string,
  args: readonly string[],
  options?: Partial<ProcessInput>,
) => Promise<ProcessResult>;
