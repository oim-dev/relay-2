import type { DocumentEntity } from "domains/documents";
/** Компактная строка каталога. */
export type DocumentCardProps = {
  /** Серверная карточка без Markdown. */
  document: DocumentEntity;
  /** Название раздела. */
  sectionName: string;
  /** Прямой адрес чтения. */
  href: string;
  /** Возврат к текущей выборке. */
  returnTo: string;
};
