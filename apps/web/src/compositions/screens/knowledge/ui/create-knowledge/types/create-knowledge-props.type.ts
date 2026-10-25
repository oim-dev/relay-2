import type { CatalogKind } from "domains/knowledge";
/**
 * Создание знания из выбранного каталога.
 */
export interface CreateKnowledgeProps {
  /* Вид нового знания. */
  readonly kind: CatalogKind;
  /* Закрытие без потери черновика. */
  readonly onClose: () => void;
  /* Переход к подтверждённой карточке. */
  readonly onSaved: (id: string) => void;
}
