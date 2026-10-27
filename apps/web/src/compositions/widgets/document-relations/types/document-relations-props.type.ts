import type { DocumentRelation, DocumentEntity } from "domains/documents";

/** Адресные связи документа в просмотре и редакторе. */
export type DocumentRelationsProps = {
  /** Подтверждённые либо черновые отношения. */
  value: DocumentRelation[];
  /** Уже прочитанные карточки сущностей. */
  references?: DocumentEntity[];
  /** ID документа исключается из вариантов. */
  documentId?: string;
  /** Применение к черновику или серверное сохранение. */
  onChange: (value: DocumentRelation[]) => void | Promise<void>;
  /** Связи записываются вместе с формой. */
  isDraft?: boolean;
};
