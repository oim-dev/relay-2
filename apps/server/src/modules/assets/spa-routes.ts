/**
 * Зарегистрированные семейства адресов исходного и восстановленного Web.
 * Сегмент сущности остаётся непрозрачным адресом; лишние сегменты не получают HTML.
 */
const routes = [
  /^\/?$/,
  /^\/(?:board|boards|documents|plans|releases|history|work-history|settings|infrastructure|relations)\/?$/,
  /^\/(?:knowledge|entities|tasks|plans|releases)\/[^/]+\/?$/,
  /^\/documents\/[^/]+(?:\/edit)?\/?$/,
  /^\/boards\/[^/]+(?:\/[^/]+)?\/?$/,
  /^\/history\/sessions\/[^/]+\/?$/,
  /^\/relations\/context\/?$/,
  /^\/product\/?$/,
  /^\/product\/passport(?:\/edit)?\/?$/,
  /^\/product\/features(?:\/[^/]+(?:\/edit|\/scenarios\/[^/]+(?:\/edit)?)?)?\/?$/,
  /^\/product\/applications(?:\/[^/]+(?:\/edit|\/scope|\/implementations\/[^/]+(?:\/edit)?)?)?\/?$/,
  /^\/product\/scenarios\/[^/]+\/?$/,
  /^\/product\/implementations\/[^/]+(?:\/edit)?\/?$/,
  /^\/product\/documents(?:\/[^/]+(?:\/edit)?)?\/?$/,
];

/**
 * Ограничивает SPA fallback проектным адресом и реальными ветками маршрутизатора.
 */
export function isSpaRoute(path: string): boolean {
  try {
    // Ссылка сущности может содержать encoded slash. Это один непрозрачный сегмент
    // React Router, а не путь к файлу; после декодирования он снова экранируется.
    const segments = path.split("/").map(decodeURIComponent);
    if (segments.some((segment) => segment === "." || segment === ".." || segment.includes("\0"))) {
      return false;
    }
    const canonical = segments.map(encodeURIComponent).join("/");
    const match = /^\/projects\/[^/]+(\/.*)?$/.exec(canonical);
    return match !== null && routes.some((route) => route.test(match[1] ?? ""));
  } catch {
    return false;
  }
}
