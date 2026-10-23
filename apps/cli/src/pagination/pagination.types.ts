import type { CURSOR_VERSION } from "./pagination.constants";

/**
 * Сериализованное положение страницы; привязано к проекту, запросу и поколению данных.
 */
export interface Cursor {
  /* Версия формата, определённая владельцем кодирования курсоров. */
  readonly version: typeof CURSOR_VERSION;
  /* Идентичность выбранной базы либо локального источника списка. */
  readonly context: string;
  /* SHA-256 отпечаток нормализованного запроса. */
  readonly query: string;
  /* Поколение БД или отпечаток локальных данных на момент первой страницы. */
  readonly generation: number | string;
  /* Смещение следующего окна; в курсоре всегда положительное целое. */
  readonly offset: number;
  /* Размер окна, сохранённый первой страницей. */
  readonly limit: number;
}

/**
 * Метаданные страницы CLI; total, items и generation относятся к одному снимку источника.
 */
export interface Page {
  /* Число фактически выданных записей, не превышающее limit. */
  readonly count: number;
  /* Число всех записей запроса в согласованном снимке. */
  readonly total: number;
  /* Размер окна, унаследованный от курсора либо заданный для первой страницы. */
  readonly limit: number;
  /* Курсор следующего окна; null означает конец списка. */
  readonly nextCursor: string | null;
  /* Готовая shell-команда продолжения; null означает конец списка. */
  readonly nextCommand: string | null;
  /* Гарантия проверки неизменности поколения между страницами. */
  readonly consistency: "snapshot";
}

/**
 * Проверенное окно чтения источника без загрузки предшествующих записей.
 */
export interface PageWindow {
  /* Число пропускаемых записей, начиная с нуля. */
  readonly offset: number;
  /* Максимальное число записей окна в границах CLI. */
  readonly limit: number;
}

/**
 * Записи окна, полное число совпадений и необязательный владелец из одного снимка.
 */
export interface PageSelection<T> {
  /* Записи в устойчивом порядке запроса. */
  readonly items: T[];
  /* Число совпадений до применения окна. */
  readonly total: number;
  /* Метаданные владельца состава из снимка источника; отсутствие означает обычный список. */
  readonly owner?: Readonly<Record<string, unknown>>;
}

/**
 * Уже вычисленный состав либо ленивый читатель окна.
 * Переданный массив ограничивает только выдачу; стоимость его вычисления несёт вызывающий код.
 */
export type PageSource<T> = readonly T[] | ((window: PageWindow) => PageSelection<T>);

/**
 * Привязка страницы к согласованному источнику и пользовательскому запросу.
 */
export interface PaginationOptions {
  /* Идентичность базы проекта либо внешнего локального списка. */
  readonly context: string;
  /* JSON-сериализуемая идентичность запроса без cursor и limit. */
  readonly query: unknown;
  /* Поколение из того же снимка, в котором будет прочитано окно. */
  readonly generation: number | string;
  /* Размер первой страницы; для продолжения без explicitLimit берётся из курсора. */
  readonly limit: number;
  /* Признак явного --limit: запрещает менять сохранённый размер окна. */
  readonly explicitLimit: boolean;
  /* Отсутствующее значение начинает список с первой записи. */
  readonly cursor?: string;
  /* Формирователь команды следующей страницы; вызывается только при наличии продолжения. */
  readonly command: (cursor: string, limit: number) => string;
}

/**
 * Выданное окно и метаданные для JSON-ответа и текстового представления.
 */
export interface Paginated<T> {
  /* Записи текущего окна в порядке источника. */
  readonly items: T[];
  /* Метаданные согласованности и продолжения списка. */
  readonly page: Page;
  /* Метаданные владельца из источника; не относятся к курсору или параметрам запроса. */
  readonly owner?: Readonly<Record<string, unknown>>;
}

/**
 * Идентичность локального списка, не требующего открытия проектной БД.
 */
export interface LocalPageSource {
  /* Идентичность конфигурации и параметров выбранного локального источника. */
  readonly context: string;
  /* Поколение или отпечаток полного состава источника. */
  readonly generation: string | number;
}
