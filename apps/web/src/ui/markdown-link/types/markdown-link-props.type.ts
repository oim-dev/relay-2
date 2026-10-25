import type { ComponentPropsWithoutRef } from "react";

/** Параметры визуальной области. */
export type MarkdownLinkParams = {
  /** Служебный AST-узел Markdown; не передаётся в DOM или компонент ссылки. */
  node?: unknown;
};
/** Атрибуты корневого элемента. */
type RootAttrs = ComponentPropsWithoutRef<"a">;
/** Свойства визуальной области. */
export type MarkdownLinkProps = RootAttrs & MarkdownLinkParams;
