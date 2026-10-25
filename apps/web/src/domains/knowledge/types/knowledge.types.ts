import type { KnowledgeKind, KnowledgeRecord } from "@relay/contracts";
import type { VersionedEntity } from "domains/project";

/**
 * Каталог продуктовых знаний, представляемый экраном.
 */
export type CatalogKind = Exclude<KnowledgeKind, "project" | "document" | "board">;

/**
 * Исходное чтение владельца записи; сохраняется вместе с черновиком.
 */
export type KnowledgeSnapshot = VersionedEntity;

/**
 * Запись каталога с сохранением дискриминации kind/data.
 */
export type CatalogEntity = KnowledgeRecord<CatalogKind>;
