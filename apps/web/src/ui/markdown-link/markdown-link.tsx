import { useContext } from "react";
import { MarkdownLinkContext } from "./providers/markdown-link-provider/markdown-link-context";
import type { MarkdownLinkProps } from "./types/markdown-link-props.type";

/**
 * Отображает Markdown-ссылку через компонент, заданный владельцем навигации.
 *
 * Используется для:
 *  - одинаковых переходов из описаний, истории и предпросмотра редакторов
 */
export const MarkdownLink = (props: MarkdownLinkProps) => {
  const anchorAttrs = { ...props };
  delete anchorAttrs.node;
  const Component = useContext(MarkdownLinkContext);
  return <Component {...anchorAttrs} />;
};
