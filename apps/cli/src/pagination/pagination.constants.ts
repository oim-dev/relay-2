/** Минимальное число записей в странице CLI. */
export const MIN_PAGE_SIZE = 1;
/** Максимальное число записей в странице CLI, совместимое с окнами Core. */
export const MAX_PAGE_SIZE = 100;
/** Размер первой страницы при отсутствии явного --limit. */
export const DEFAULT_PAGE_SIZE = 20;
/** Версия сериализованного формата курсора; изменение требует совместимого декодирования. */
export const CURSOR_VERSION = 1;
/** Длина усечённой SHA-256 суммы курсора в шестнадцатеричных символах. */
export const CURSOR_CHECKSUM_LENGTH = 16;
