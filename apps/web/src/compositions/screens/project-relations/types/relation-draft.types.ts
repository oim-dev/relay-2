import type { RelationFormValues } from "../ui/relation-editor/types/relation-editor-props.type";

/**
 * Независимый снимок формы текущей вкладки; operationKey хранит relay-data.
 */
export interface RelationDraftSnapshot {
  /* Исходный generation, не обновляется от SSE или повторного mount. */
  version: string;
  /* Пользовательский ввод, включая незавершённый. */
  values: RelationFormValues;
  /* Отправленный запрос нужно восстановить до редактирования. */
  uncertain: boolean;
  /* Последняя диагностика; null до отказа. */
  error: string | null;
}

/**
 * Владение одной формой; новый mount того же ключа отзывает старое право публикации.
 */
export interface RelationDraftLease {
  /* Проверяет актуальность экземпляра до записи storage/React state. */
  isCurrent: () => boolean;
  /* Освобождает только собственное право. */
  dispose: () => void;
}

/**
 * Подтверждение удаления одной связи, сохраняемое при переходе между проектами.
 */
export interface RelationRemovalDraft {
  /* Выбранный адрес для возврата к диагностике. */
  root: string;
  /* Производный ID исходного структурированного ребра. */
  edgeId: string;
  /* Исходный generation. */
  version: string;
}
