import { stripVTControlCharacters } from "node:util";
import { outputLabels, outputMessages } from "../locales/output";
import type { EntityPresentation, PagePresentation, Result } from "./output.types";
import type { Page } from "../pagination/pagination.types";

/**
 * Оборачивает данные предметного сценария без изменения формы и без вывода в потоки.
 */
export function result(data: unknown): Result {
  return { data };
}

/**
 * Удаляет терминальные управляющие и bidi-последовательности из текста для человека.
 * Переводы строк, табуляция, Markdown и обычный Unicode сохраняются; JSON через это не проходит.
 */
export function terminalText(value: string): string {
  return stripVTControlCharacters(value)
    .replace(/[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/gu, "")
    .replace(/\p{Cc}/gu, (character) =>
      character === "\n" || character === "\t" ? character : "",
    );
}

/**
 * Распознаёт объект для представления; предметное декодирование остаётся ответственностью Core.
 */
function isObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Отличает оболочку записи от обычного объекта, проверяя доступность её полей содержания.
 */
function isEntity(value: unknown): value is EntityPresentation {
  return isObject(value) && "kind" in value && "key" in value && isObject(value.data);
}

/**
 * Распознаёт состав страницы до выделения списка и дополнительных полей владельца.
 */
function isPage(value: unknown): value is PagePresentation {
  return isObject(value) && Array.isArray(value.items);
}

/**
 * Форматирует полное значение рекурсивно, не усекая длинные тексты и вложенные составы.
 * Содержание data записи раскрывается на том же уровне, что и её метаданные.
 */
function renderFullValue(value: unknown): string {
  if (value === null) {
    return outputMessages.missing;
  }
  if (typeof value === "boolean") {
    return value ? outputMessages.yes : outputMessages.no;
  }
  if (typeof value !== "object") {
    return String(value);
  }
  if (Array.isArray(value)) {
    return value.length
      ? value.map((entry) => outputMessages.listItem(renderFullValue(entry))).join("\n")
      : outputMessages.no;
  }
  return Object.entries(value)
    .map(([key, entry]) => {
      if (key === "data" && isEntity(value)) {
        return renderFullValue(entry);
      }
      return outputMessages.field(outputLabels[key] ?? key, renderFullValue(entry));
    })
    .join("\n");
}

/**
 * Форматирует одну запись списка; неизвестную форму показывает полностью вместо пустой строки.
 */
function renderSummary(value: unknown): string {
  if (isEntity(value)) {
    const name = value.data.title ?? value.data.name ?? "";
    const state = value.data.column ?? value.data.status;
    return outputMessages.entity(
      String(value.key),
      String(name).replace(/\s+/g, " "),
      String(value.revision),
      state ? String(state) : undefined,
    );
  }
  if (isObject(value)) {
    let completion: string | undefined;
    if (typeof value.completed === "boolean") {
      completion = value.completed ? outputMessages.completed : outputMessages.unfinished;
    }
    const parts = [
      value.id ?? value.name,
      value.title ?? value.name,
      value.status,
      completion,
      value.configPath,
    ].filter((part) => part !== undefined);
    return outputMessages.summary(parts) || renderFullValue(value);
  }
  return renderFullValue(value);
}

/**
 * Показывает владельца состава, краткое окно, счётчик и команду продолжения при её наличии.
 */
function renderPage(data: PagePresentation, page: Page): string {
  const { items, ...rest } = data;
  const header = Object.keys(rest).length ? `${renderFullValue(rest)}\n\n` : "";
  const entries = items.length ? items.map(renderSummary).join("\n") : outputMessages.emptyPage;
  let text = `${header}${entries}\n\n${outputMessages.pageCount(page.count, page.total)}`;
  if (page.nextCommand) {
    text += `\n${outputMessages.continuation(page.nextCommand)}`;
  }
  return text;
}

/**
 * Создаёт успешный JSON-ответ либо безопасное для терминала текстовое представление.
 * JSON сохраняет исходные данные дословно; функция не пишет в stdout и не добавляет финальный LF.
 */
export function renderResult(result: Result, format: string): string {
  if (format === "json") {
    return JSON.stringify({ ok: true, ...result });
  }
  const page = result.meta?.page;
  const text =
    page && isPage(result.data) ? renderPage(result.data, page) : renderFullValue(result.data);
  return terminalText(text);
}
