import { MarkdownLinkContext } from "./markdown-link-context";
import type { MarkdownLinkProviderProps } from "./types/markdown-link-provider-props.type";

/**
 * Подключает единый компонент ссылок для Markdown внутри своего дерева React.
 *
 * Используется для:
 *  - настройки переходов в том числе внутри модальных окон и порталов
 */
export const MarkdownLinkProvider = (props: MarkdownLinkProviderProps) => {
  const { children, component } = props;
  return <MarkdownLinkContext value={component}>{children}</MarkdownLinkContext>;
};
