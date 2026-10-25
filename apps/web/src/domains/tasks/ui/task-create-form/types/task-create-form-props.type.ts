/**
 * Создание задачи на доске или дочерней задачи без CAS чужого содержания.
 */
export interface TaskCreateFormProps {
  /* Постоянный ID выбранной доски. */
  readonly boardId: string;
  /* Постоянный ID родителя; отсутствие создаёт корневую задачу. */
  readonly parentId?: string;
  /* Навигация после достоверного committed-результата. */
  readonly onCreated: (id: string) => void;
}
