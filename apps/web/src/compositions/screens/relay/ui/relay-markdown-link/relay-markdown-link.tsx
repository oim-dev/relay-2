import { Link } from "react-router-dom";
import type { RelayMarkdownLinkProps } from "./types/relay-markdown-link-props.type";

/**
 * Сохраняет SPA-навигацию для Markdown-ссылок на страницы Relay.
 *
 * Используется для:
 *  - переходов из описаний без перезапуска приложения
 *  - обычных внешних ссылок и скачивания файлов
 */
export const RelayMarkdownLink = (props: RelayMarkdownLinkProps) => {
  const { href, children, ...anchorAttrs } = props;
  if (href === undefined || props.download !== undefined) return <a {...props}>{children}</a>;
  let url: URL;
  try {
    url = new URL(href, window.location.href);
  } catch {
    return <a {...props}>{children}</a>;
  }
  const isInternal =
    url.origin === window.location.origin &&
    (url.pathname === "/" || url.pathname.startsWith("/projects/"));
  if (!isInternal) return <a {...props}>{children}</a>;
  return (
    <Link {...anchorAttrs} to={`${url.pathname}${url.search}${url.hash}`}>
      {children}
    </Link>
  );
};
