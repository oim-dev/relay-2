import type { CatalogKind, KnowledgeSnapshot } from "domains/knowledge";
/**
 * Открытие формы после готового versioned read.
 */
export interface KnowledgeEditorProps {
  /* Каталог допустимых полей. */
  readonly kind: CatalogKind;
  /* Исходная карточка; null создаёт новую. */
  readonly source: KnowledgeSnapshot | null;
  /* Приложение при создании реализации; иначе null. */
  readonly owner: KnowledgeSnapshot | null;
  /* Завершает сценарий после подтверждённой квитанции. */
  readonly onSaved: (id: string) => void;
  /* Закрывает форму, не уничтожая черновик. */
  readonly onClose: () => void;
}
