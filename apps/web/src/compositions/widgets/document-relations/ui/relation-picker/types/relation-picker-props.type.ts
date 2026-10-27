import type { DocumentRelation } from "domains/documents";

/** Независимый черновик выбора связей в диалоге. */
export type RelationPickerProps = {
  /** Начальный набор связей. */
  initial: DocumentRelation[];
  /** Собственный ID документа. */
  documentId?: string | undefined;
  /** Применение только к редактору. */
  isDraft: boolean;
  /** Применение после проверки выбора. */
  onApply: (links: DocumentRelation[]) => void | Promise<void>;
  /** Закрытие после успеха либо отмены. */
  onClose: () => void;
};
