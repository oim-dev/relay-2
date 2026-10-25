import type { CriterionDraft } from "../../../types/task-editor.types";

/**
 * Редактор одного критерия с сохраняемым родителем черновиком.
 */
export interface CriterionFormProps {
  /* Снимок задачи и введённые поля, не обновляемые из SSE. */
  readonly draft: CriterionDraft;
  /* Имя операции в области проекта, общее при восстановлении формы. */
  readonly name: string;
  /* Сохраняет ввод без замены исходной версии. */
  readonly onChange: (draft: CriterionDraft) => void;
  /* Закрывает форму после успеха либо явной отмены известного запроса. */
  readonly onClose: () => void;
}
