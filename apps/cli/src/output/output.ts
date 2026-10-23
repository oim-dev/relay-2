import type { Result, TextPresentation } from "./output.types";
import { isPage, renderFullValue } from "./values";
import { renderPage } from "./pages";
import { renderConfiguration, renderOverview } from "./project";
import { renderEntityRead } from "./reads";
import { terminalText } from "./terminal";

/**
 * Оборачивает данные предметного сценария без изменения формы и без вывода в потоки.
 */
export function result(data: unknown): Result {
  return { data };
}

/**
 * Создаёт единый JSON-ответ, включая частичный отказ, либо безопасное текстовое представление.
 * Макет выбирается регистрацией отдельно от результата; JSON сохраняет исходные данные.
 * Функция не пишет в stdout и не добавляет финальный LF.
 */
export function renderResult(
  result: Result,
  format: string,
  presentation?: TextPresentation,
): string {
  if (format === "json") {
    const { failure, ...payload } = result;
    const error = failure && {
      code: failure.code,
      message: failure.message,
      ...(failure.details ? { details: failure.details } : {}),
    };
    return JSON.stringify({ ok: !failure, ...payload, ...(error ? { error } : {}) });
  }
  if (presentation === "entity-read") {
    return terminalText(renderEntityRead(result.data));
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
