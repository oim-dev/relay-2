import type { DocumentRelation } from "domains/documents";
/** Документы в контексте задачи или продуктовой сущности. */
export type EntityDocumentsProps = {
  /** Постоянный адрес сущности. */
  target: DocumentRelation["target"];
  /** Освобождает фокус родительского диалога на время выбора документов. */
  onOpenedChange?: (opened: boolean) => void;
};
