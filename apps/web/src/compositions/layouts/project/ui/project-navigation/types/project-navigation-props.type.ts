import type { ComponentPropsWithoutRef } from "react";

/** Параметры навигации выбранного проекта. */
export type ProjectNavigationParams = {
  /** Корень маршрутов проекта. */
  basePath: string;
  /** Завершение выбора пункта, например закрытие мобильного сайдбара. */
  onNavigate?: () => void;
};
/** Атрибуты корневого элемента. */
type RootAttrs = Omit<ComponentPropsWithoutRef<"nav">, "children" | "aria-label">;
/** Свойства проектного сайдбара. */
export type ProjectNavigationProps = RootAttrs & ProjectNavigationParams;
