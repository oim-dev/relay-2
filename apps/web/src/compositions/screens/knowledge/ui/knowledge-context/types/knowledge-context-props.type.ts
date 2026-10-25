import type { CatalogEntity } from "domains/knowledge";
/**
 * Контекст прочитанного требования или приложения.
 */
export interface KnowledgeContextProps {
  /* Текущая карточка, определяющая фильтры связанных записей. */
  readonly entity: CatalogEntity;
}
