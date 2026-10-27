import type { KnowledgeDocument, DocumentInput } from "domains/documents";
/** Контекст, отношения и оглавление читаемого материала. */
export type DocumentContextProps = {
  /** Подтверждённый документ. */
  document: KnowledgeDocument;
  /** Название его раздела. */
  sectionName: string;
  /** Заголовки отрисованного Markdown. */
  outline: { id: string; title: string; level: number }[];
  /** Запись изменения с исходной ревизией. */
  onSave: (changes: Partial<DocumentInput>) => Promise<void>;
};
