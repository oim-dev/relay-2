import type { ComponentPropsWithoutRef } from "react";
import type { ProductStatus } from "../../../types/product-demo.type";

/** Параметры неизменяемого индикатора готовности. */
export type ProductReadinessParams = {
  /** Готовность сценария либо вычисленная готовность фичи. */
  status: ProductStatus | undefined;
  /** Скрывает видимую подпись, сохраняя доступное название и подсказку. */
  isCompact?: boolean;
  /** Уточнение для фичи без описанных сценариев. */
  label?: string;
};
/** Атрибуты корневого элемента. */
type RootAttrs = Omit<ComponentPropsWithoutRef<"span">, "children" | "title">;
/** Свойства индикатора готовности. */
export type ProductReadinessProps = RootAttrs & ProductReadinessParams;
