import type { DocumentRelation } from "@relay/contracts";
import type { KnowledgeSnapshot } from "domains/knowledge";
import type { DocumentContent } from "domains/documents";

/**
 * Ввод одной связи с постоянным ID цели.
 */
export interface RelationValues {
  /* Устойчивый ключ строки формы; в Core не отправляется. */
  rowId: string;
  /* Каталог выбора цели; тип берётся из Contracts. */
  targetKind: DocumentRelation["target"]["kind"];
  /* Постоянный ID цели; null до выбора. */
  target: string | null;
  /* Семантика связи. */
  type: DocumentRelation["type"];
  /* Пояснение связи. */
  description: string;
}

/**
 * Пользовательский ввод документа; Markdown не преобразуется перед сохранением.
 */
export interface DocumentValues {
  /* Название материала. */
  name: string;
  /* Краткая аннотация. */
  summary: string;
  /* Полное содержимое Markdown. */
  body: string;
  /* Вид документа из Contracts. */
  documentKind: DocumentContent["documentKind"];
  /* Состояние публикации из Contracts. */
  documentStatus: DocumentContent["documentStatus"];
  /* ID раздела; null означает отсутствие раздела. */
  sectionId: string | null;
  /* Закрепление в библиотеке. */
  pinned: boolean;
  /* Редактируемые связи в пользовательском порядке. */
  relations: RelationValues[];
}

/**
 * Документ и исходные guards не зависят от обновления GET-кеша.
 */
export interface DocumentDraft {
  /* Первоначальная карточка; null при создании. */
  readonly source: KnowledgeSnapshot | null;
  /* Сохраняемый ввод формы. */
  readonly values: DocumentValues;
}
