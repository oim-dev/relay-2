import { z } from "zod";
import {
  DOCUMENT_KINDS,
  DOCUMENT_STATUSES,
  DOCUMENT_TARGET_KINDS,
  DOCUMENT_RELATION_TYPES,
} from "@relay/contracts";
import type { EntitySummary } from "domains/entities";

/** Поля пользовательского редактора документа. */
export const DOCUMENT_INPUT_SCHEMA = z.object({
  name: z.string(),
  summary: z.string(),
  body: z.string(),
  documentKind: z.enum(DOCUMENT_KINDS),
  documentStatus: z.enum(DOCUMENT_STATUSES),
  sectionId: z.string().nullable(),
  pinned: z.boolean(),
  relations: z.array(
    z.object({
      target: z.object({ kind: z.enum(DOCUMENT_TARGET_KINDS), id: z.string() }),
      type: z.enum(DOCUMENT_RELATION_TYPES),
      description: z.string(),
    }),
  ),
});
/** Ввод самостоятельного материала библиотеки. */
export type DocumentInput = z.infer<typeof DOCUMENT_INPUT_SCHEMA>;
/** Одна явная адресная связь. */
export type DocumentRelation = DocumentInput["relations"][number];
/** Краткая карточка существующей сущности. */
export type DocumentEntity = EntitySummary;
/** Подтверждённое содержание с ревизией и именами связей. */
export type KnowledgeDocument = DocumentInput & {
  /** Постоянный ID. */
  id: string;
  /** Публичный ключ. */
  key: string;
  /** Ревизия записи. */
  revision: number;
  /** Последнее подтверждённое обновление. */
  updatedAt: string;
  /** Краткие карточки прямых целей. */
  references: DocumentEntity[];
};
/** Раздел библиотеки с постоянным ID. */
export type DocumentSection = {
  /** Идентификатор раздела. */
  id: string;
  /** Отображаемое название. */
  name: string;
};
/** Настройки общей библиотеки проекта. */
export type LibrarySettings = {
  /** Исходное имя проекта для CAS-проверки неизменного каталога. */
  projectName: string;
  /** Адрес проекта. */
  ref: string;
  /** Версия для изменения разделов. */
  revision: number;
  /** Упорядоченные разделы. */
  sections: DocumentSection[];
};
