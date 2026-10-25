import type { ComponentPropsWithoutRef, ReactNode } from "react";

/** Параметры визуальной области. */
export type {{name.pascalCase}}Params = {
  /** Содержимое области. */
  children?: ReactNode;
};
/** Атрибуты корневого элемента. */
type RootAttrs = Omit<ComponentPropsWithoutRef<"div">, "children">;
/** Свойства визуальной области. */
export type {{name.pascalCase}}Props = RootAttrs & {{name.pascalCase}}Params;
