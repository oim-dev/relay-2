/**
 * Синтаксически проверенные поля публикации комментария из CLI.
 * Предметные ограничения текста и автора проверяет сервис задач Core.
 */
export interface TaskCommentInput {
  /* Непустое тело комментария из --body, файла или JSON-ввода. */
  readonly body: string;

  /* Заголовок комментария; undefined сохраняет значение по умолчанию сервиса Core. */
  readonly title: string | undefined;
}
