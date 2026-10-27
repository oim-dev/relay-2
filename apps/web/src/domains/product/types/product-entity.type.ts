import type { z } from "zod";
import type {
  PRODUCT_ENTITY_SCHEMA,
  PRODUCT_ENTITY_SUMMARY_SCHEMA,
  PRODUCT_ENTITIES_SCHEMA,
} from "../config/product.schema";
import type { PRODUCT_TARGET_LINK_SCHEMA } from "../config/product.schema";
export type ProductTargetLink = z.infer<typeof PRODUCT_TARGET_LINK_SCHEMA>;

/** Адресная запись и краткий каталог продуктовых целей. */
export type ProductEntity = z.infer<typeof PRODUCT_ENTITY_SCHEMA>;
export type ProductEntitySummary = z.infer<typeof PRODUCT_ENTITY_SUMMARY_SCHEMA>;
export type ProductEntities = z.infer<typeof PRODUCT_ENTITIES_SCHEMA>;
export type ProductEntitiesQuery = {
  q?: string;
  kind?: ProductEntitySummary["kind"];
  application?: string;
  /** Вид цели имплементации; ограничивает каталог до пагинации. */
  implementationTarget?: "feature" | "scenario";
  refs?: string[];
  active?: "true" | "false";
  offset?: number;
  limit?: number;
  /** Исходное поколение продолжения. */
  version?: string;
};
/** Независимая правка реализации без ревизии соседних записей. */
export type ImplementationChange = {
  ref: string;
  ifRevision: number;
  requestId: string;
  title?: string;
  description?: string;
  status?: "none" | "partial" | "done";
  key?: string;
};
