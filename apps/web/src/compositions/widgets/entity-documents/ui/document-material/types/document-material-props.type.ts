import type { DocumentRelation, KnowledgeRecord } from "@relay/contracts";
import type { MaterialTarget } from "../../../types/entity-documents-props.type";

/**
 * Один материал в ограниченной странице связанных документов.
 */
export interface DocumentMaterialProps {
  /* Прочитанный документ с текущими отношениями. */
  readonly document: KnowledgeRecord<"document">;
  /* Цель, по которой выбран список. */
  readonly target: MaterialTarget;
  /* Постоянная ссылка на деталь документа. */
  readonly href: string;
  /* Есть другая незавершённая запись связи; новую начинать нельзя. */
  readonly disabled: boolean;
  /* Открывает предварительное чтение документа для снятия конкретной пары. */
  readonly onUnlink: (documentId: string, type: DocumentRelation["type"]) => void;
}
