import type { TaskRecord } from "@relay/contracts";

/**
 * Снимок содержания при начале действия; SSE его не заменяет.
 */
export interface TaskSnapshot {
  /* Полная задача с исходной локальной ревизией. */
  readonly task: TaskRecord;
  /* Исходная переносимая версия, если опубликована сервером. */
  readonly expectedVersion?: string;
}

/**
 * Значения формы создания; column проверяется по общему перечислению.
 */
export interface TaskCreateValues {
  /* Однострочный заголовок задачи, включая допустимую пустую строку. */
  readonly title: string;
  /* Markdown описания. */
  readonly description: string;
  /* Выбранная текущая колонка. */
  readonly column: string;
}

/**
 * Черновик создания с зафиксированной доской, в том числе после перемещения родителя.
 */
export interface TaskCreateDraft {
  /* Постоянный ID доски при начале создания. */
  readonly boardId: string;
  /* Несохранённые поля новой задачи. */
  readonly values: TaskCreateValues;
}
