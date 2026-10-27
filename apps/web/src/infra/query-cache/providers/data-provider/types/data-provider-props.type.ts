import type { ReactNode } from "react";

/**
 * Область общего кеша GET выбранного origin.
 */
export interface DataProviderProps {
  /* Дочернее дерево, использующее изолированный кеш SWR. */
  readonly children: ReactNode;
}
