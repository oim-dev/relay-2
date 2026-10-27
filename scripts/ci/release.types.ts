/**
 * Минимальная проверенная идентичность GitHub Actions run.
 */
export interface ReleaseRun {
  /* Числовой ID run в текущем репозитории. */
  readonly id: number;
  /* SHA исходников run, не SHA последнего успешного запуска ветки. */
  readonly sha: string;
  /* Путь workflow, которому принадлежит run. */
  readonly workflow: string;
  /* GitHub status; завершённый CI имеет completed. */
  readonly status: string;
  /* GitHub conclusion либо null у незавершённого запуска. */
  readonly conclusion: string | null;
}

/**
 * Проверенная карточка artifact из GitHub REST API, без загрузки его содержимого.
 */
export interface ReleaseArtifact {
  /* ID artifact для точной загрузки actions/download-artifact. */
  readonly id: number;
  /* Имя по общему протоколу id-target-SHA. */
  readonly name: string;
  /* Флаг серверного истечения retention. */
  readonly expired: boolean;
  /* Момент истечения retention в миллисекундах Unix. */
  readonly expiresAt: number;
}

/**
 * Read-only транспорт GitHub API; в тестах подменяется ответами по реальным endpoint-границам.
 */
export type ReleaseApi = (path: string) => Promise<unknown>;

/**
 * Контекст поиска CI в одном репозитории и на одном SHA.
 */
export interface ReleaseSource {
  /* GitHub owner/repo текущего workflow. */
  readonly repository: string;
  /* Полный SHA тега, проверяемый в каждой карточке run и manifest. */
  readonly sha: string;
}

/**
 * Согласованные версии root и всех приложений перед публикацией.
 */
export interface ReleaseVersion {
  /* package.json либо apps/<component>/package.json для диагностики. */
  readonly path: string;
  /* Поле version, проверенное как строка на границе JSON. */
  readonly version: string;
}
