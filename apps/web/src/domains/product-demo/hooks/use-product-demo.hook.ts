import { useContext } from "react";
import { ProductDemoContext } from "../providers/product-demo-provider/product-demo-context";
import type { ProductDemoContextValue } from "../types/product-demo.type";

/**
 * Возвращает общую модель и операции продуктового прототипа.
 */
export const useProductDemo = (): ProductDemoContextValue => {
  const context = useContext(ProductDemoContext);
  if (context === undefined) throw new Error("Область продукта не подключена");
  return context;
};
