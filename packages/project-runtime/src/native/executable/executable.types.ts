/**
 * Нативные правила имени executable, доступа к файлу и поиска в переданном окружении.
 * Окружение процесса не читается; версия и приоритет кандидатов принадлежат discovery приложения.
 */
export interface ExecutablePlatform {
  /* Суффикс самостоятельного бинарника. */
  readonly suffix: string;
  /**
   * Проверяет необходимые для запуска права; ошибки ФС передаются вызывающему.
   */
  checkAccess(path: string): void;
  /**
   * Читает непустые каталоги PATH, сохраняя их порядок.
   */
  searchPath(environment: Readonly<Record<string, string | undefined>>): readonly string[];
}
