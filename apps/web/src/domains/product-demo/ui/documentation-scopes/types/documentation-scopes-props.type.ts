import type { ComponentPropsWithoutRef } from "react";

/** Параметры визуальной области. */
export type DocumentationScopesParams = {
  /** Выбранные ключи моковых областей. */
  scopeIds: string[];
  /** Максимальное число меток в компактном представлении. */
  limit?: number;
  /** Полные пути областей для чтения документа. */
  isDetailed?: boolean;
};
/** Атрибуты корневого элемента. */
type RootAttrs = Omit<ComponentPropsWithoutRef<"div">, "children">;
/** Свойства визуальной области. */
export type DocumentationScopesProps = RootAttrs & DocumentationScopesParams;
