import type { KnowledgeSnapshot } from "domains/knowledge";
/**
 * Изменение участия одной реализации с полным исходным составом приложения.
 */
export interface ParticipationEditorProps {
  /* Исходный versioned read приложения, которому принадлежит CAS. */
  readonly owner: KnowledgeSnapshot;
  /* Постоянный ID переключаемой реализации. */
  readonly implementationId: string;
  /* Завершение после подтверждённой записи. */
  readonly onSaved: () => void;
  /* Закрытие с сохранением ввода. */
  readonly onClose: () => void;
}

/**
 * Сохраняемый пользовательский выбор активности.
 */
export interface ParticipationDraft {
  /* Первоначальная версия приложения. */
  readonly owner: KnowledgeSnapshot;
  /* Желаемая активность выбранной реализации. */
  readonly active: boolean;
}
