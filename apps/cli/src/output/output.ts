import { stripVTControlCharacters } from "node:util";
import type { Result, TextPresentation } from "./output.types";
import { isPage, renderFullValue } from "./values";
import { renderPage } from "./pages";
import { renderConfiguration, renderOverview } from "./project";

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
 * Создаёт успешный JSON-ответ либо безопасное для терминала текстовое представление.
 * Макет выбирается регистрацией отдельно от результата; JSON сохраняет исходные данные.
 * Функция не пишет в stdout и не добавляет финальный LF.
 */
export function renderResult(
  result: Result,
  format: string,
  presentation?: TextPresentation,
): string {
  if (format === "json") {
    return JSON.stringify({ ok: true, ...result });
  }
  if (presentation === "configuration") {
    return terminalText(renderConfiguration(result));
  }
  const page = result.meta?.page;
  if (page && isPage(result.data)) {
    const text =
      presentation === "overview"
        ? renderOverview(result.data, page)
        : renderPage(result.data, page, presentation);
    return terminalText(text);
  }
  return terminalText(renderFullValue(result.data));
}
