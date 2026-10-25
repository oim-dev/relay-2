import type { ComponentPropsWithoutRef, ComponentType, ReactNode } from "react";

/** Параметры визуальной области. */
export type MarkdownLinkProviderProps = {
  /** Содержимое области. */
  children: ReactNode;
  /** Компонент ссылки с правилами навигации владельца области. */
  component: ComponentType<ComponentPropsWithoutRef<"a">>;
};
