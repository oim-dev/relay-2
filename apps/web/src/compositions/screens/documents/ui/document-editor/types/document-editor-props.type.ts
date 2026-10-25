import type { KnowledgeSnapshot } from "domains/knowledge";
/**
 * Готовый контекст открытия формы документа.
 */
export interface DocumentEditorProps {
  /* Исходная версия документа; null для создания. */
  readonly source: KnowledgeSnapshot | null;
  /* Раздел создания; null оставляет материал вне разделов. */
  readonly sectionId: string | null;
  /* Завершение после подтверждённой квитанции. */
  readonly onSaved: (id: string) => void;
  /* Закрывает редактор с сохранением ввода. */
  readonly onClose: () => void;
}
