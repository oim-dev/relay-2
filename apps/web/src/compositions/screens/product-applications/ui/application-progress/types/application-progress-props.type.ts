import type { ComponentPropsWithoutRef } from "react";

/** Параметры визуальной области. */
export type ApplicationProgressParams = {
  /** Slug собственной доски приложения. */
  board: string;
};
/** Атрибуты корневого элемента. */
type RootAttrs = Omit<ComponentPropsWithoutRef<"div">, "children">;
/** Свойства визуальной области. */
export type ApplicationProgressProps = RootAttrs & ApplicationProgressParams;
