import type { ComponentPropsWithoutRef } from "react";

/** Контекст просмотра участия приложения. */
export type ApplicationFeaturesParams = {
  /** Приложение, объявившее состав реализации. */
  applicationId: string;
};
/** Атрибуты корневого элемента. */
type RootAttrs = Omit<ComponentPropsWithoutRef<"section">, "children" | "id">;
/** Свойства визуальной области. */
export type ApplicationFeaturesProps = RootAttrs & ApplicationFeaturesParams;
