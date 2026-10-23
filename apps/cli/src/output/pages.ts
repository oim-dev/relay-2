import { outputLabels, outputMessages } from "../locales/output";
import type { Page } from "../pagination/pagination.types";
import type { PagePresentation, TextPresentation } from "./output.types";
import { isEntity, isObject, renderEntitySummary, renderFullValue, renderSummary } from "./values";

/**
 * Форматирует полное содержание комментария без сворачивания Markdown и пробелов.
 * Неизвестная форма сохраняется в полном виде, а не превращается в пустую карточку.
 */
function renderComment(value: unknown): string {
  if (
    !isObject(value) ||
    typeof value.id !== "string" ||
    typeof value.title !== "string" ||
    typeof value.body !== "string" ||
    typeof value.createdBy !== "string" ||
    typeof value.createdAt !== "string"
  ) {
    return renderFullValue(value);
  }
  const lines = [outputMessages.field(outputMessages.comment, value.id)];
  if (value.title !== "") {
    lines.push(outputMessages.field(outputLabels.title, value.title));
  }
  lines.push(
    outputMessages.field(outputMessages.commentAuthor, value.createdBy),
    outputMessages.field(outputLabels.createdAt, value.createdAt),
    outputMessages.commentBody(value.body),
  );
  return lines.join("\n");
}

/**
 * Показывает одну регистрацию без повторения имени; остальные формы не сокращает.
 */
function renderWorkspaceProject(value: unknown): string {
  if (isObject(value) && typeof value.name === "string" && typeof value.path === "string") {
    return outputMessages.summary([value.name, value.path]);
  }
  return renderFullValue(value);
}

/**
 * Показывает отношения дерева в исходном порядке окна, не изображая внешних родителей корнями.
 * Ключ родителя берётся только из текущей страницы; вне неё сохраняется полный постоянный ID.
 */
function renderSessionTree(items: readonly unknown[]): string {
  const keys = new Map<string, string>();
  for (const item of items) {
    if (isEntity(item) && typeof item.id === "string" && typeof item.key === "string") {
      keys.set(item.id, item.key);
    }
  }
  return items
    .map((item) => {
      if (!isEntity(item) || item.kind !== "work-session") {
        return renderFullValue(item);
      }
      const parent = item.data.parentSessionId;
      const summary = renderEntitySummary(item, { preserveTitleWhitespace: true });
      if (parent === null) {
        return outputMessages.summary([summary, outputMessages.sessionRoot]);
      }
      if (typeof parent !== "string") {
        return renderFullValue(item);
      }
      const key = keys.get(parent);
      const relation =
        key === undefined
          ? outputMessages.sessionParentOutsidePage(parent)
          : outputMessages.sessionParent(key);
      return `${summary}\n${relation}`;
    })
    .join("\n");
}

/**
 * Выбирает только явно зарегистрированный макет элементов; обычные списки остаются краткими.
 */
function renderPageItems(items: readonly unknown[], presentation?: TextPresentation): string {
  if (!items.length) {
    return outputMessages.emptyPage;
  }
  switch (presentation) {
    case "task-comments":
      return items.map(renderComment).join("\n\n");
    case "session-tree":
      return renderSessionTree(items);
    case "workspace-projects":
      return items.map(renderWorkspaceProject).join("\n");
    default:
      return items.map(renderSummary).join("\n");
  }
}

/**
 * Возвращает полную команду продолжения либо пустую строку для последней страницы.
 */
export function renderPageContinuation(page: Page): string {
  return page.nextCommand ? outputMessages.continuation(page.nextCommand) : "";
}

/**
 * Показывает владельца состава, текущее окно, счётчик и неизменённую команду продолжения.
 */
export function renderPage(
  data: PagePresentation,
  page: Page,
  presentation?: TextPresentation,
): string {
  const { items, ...rest } = data;
  const header = Object.keys(rest).length ? `${renderFullValue(rest)}\n\n` : "";
  const entries = renderPageItems(items, presentation);
  const footer = [outputMessages.pageCount(page.count, page.total), renderPageContinuation(page)]
    .filter((line) => line !== "")
    .join("\n");
  return `${header}${entries}\n\n${footer}`;
}
