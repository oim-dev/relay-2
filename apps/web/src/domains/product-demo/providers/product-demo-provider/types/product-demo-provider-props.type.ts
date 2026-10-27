import type { ReactNode } from "react";

/** Область жизни мокового продукта. */
export type ProductDemoProviderProps = {
  /** Проект, которому принадлежит локальный снимок. */
  scopeId: string;
  /** Подразделы продукта. */
  children?: ReactNode;
};
