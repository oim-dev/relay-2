import { createContext } from "react";
import type { ProductDemoContextValue } from "../../types/product-demo.type";

/** Модель существует в области раздела конкретного проекта. */
export const ProductDemoContext = createContext<ProductDemoContextValue | undefined>(undefined);
