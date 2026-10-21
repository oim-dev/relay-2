import type { Page } from "../../../src/pagination/pagination.types";

/**
 * Проверенный конверт успешного JSON-ответа; содержание декодируется отдельно.
 */
export interface SuccessResponse {
  /* Содержание ответа, форма которого определяется конкретной командой. */
  readonly data: unknown;

  /* Дополнительные данные команды; отсутствие означает ответ без метаданных. */
  readonly meta?: Readonly<Record<string, unknown>>;
}

/**
 * Проверенная страница с декодированными элементами и метаданными снимка.
 */
export interface PageResponse<T> {
  /* Поля состава и элементы выбранного окна в порядке, возвращённом CLI. */
  readonly data: Readonly<Record<string, unknown>> & {
    /* Декодированные элементы текущей страницы. */
    readonly items: readonly T[];
  };

  /* Метаданные согласованного окна списка. */
  readonly meta: {
    /* Параметры страницы и продолжения того же запроса. */
    readonly page: Page;
  };
}

/**
 * Проверенная предметная ошибка из JSON-потока stderr.
 */
export interface ErrorResponse {
  /* Стабильный машинный код отказа. */
  readonly code: string;

  /* Человекочитаемое объяснение отказа. */
  readonly message: string;

  /* Структурированные детали; отсутствуют, если команда их не возвращает. */
  readonly details?: Readonly<Record<string, unknown>>;
}
