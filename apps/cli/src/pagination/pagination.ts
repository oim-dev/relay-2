import { createHash } from "node:crypto";
import { RelayError } from "@relay/contracts";
import { CliUsageError } from "../errors/errors";
import { paginationMessages } from "../locales/pagination";
import {
  CURSOR_CHECKSUM_LENGTH,
  CURSOR_VERSION,
  MAX_PAGE_SIZE,
  MIN_PAGE_SIZE,
} from "./pagination.constants";
import type { Cursor, Paginated, PageSource, PaginationOptions } from "./pagination.types";

/**
 * Вычисляет SHA-256 по JSON-представлению значения; порядок полей является частью отпечатка.
 * Вызывающий код передаёт сериализуемые данные и заранее нормализует порядок параметров запроса.
 */
export function fingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

/**
 * Кодирует проверенное положение страницы с контрольной суммой от случайного повреждения.
 * Контрольная сумма не является подписью и не предоставляет права доступа к проекту.
 */
function encode(cursor: Cursor): string {
  const json = JSON.stringify(cursor);
  return `${Buffer.from(json).toString("base64url")}.${fingerprint(json).slice(0, CURSOR_CHECKSUM_LENGTH)}`;
}

/**
 * Проверяет структуру декодированного курсора до использования смещения и привязок запроса.
 */
function isCursor(value: unknown): value is Cursor {
  if (!value || typeof value !== "object") {
    return false;
  }
  return (
    "version" in value &&
    value.version === CURSOR_VERSION &&
    "context" in value &&
    typeof value.context === "string" &&
    "query" in value &&
    typeof value.query === "string" &&
    "generation" in value &&
    (typeof value.generation === "number" || typeof value.generation === "string") &&
    "offset" in value &&
    typeof value.offset === "number" &&
    Number.isSafeInteger(value.offset) &&
    value.offset >= 1 &&
    "limit" in value &&
    typeof value.limit === "number" &&
    Number.isSafeInteger(value.limit) &&
    value.limit >= MIN_PAGE_SIZE &&
    value.limit <= MAX_PAGE_SIZE
  );
}

/**
 * Проверяет контрольную сумму и форму внешнего курсора, сохраняя причину ошибки JSON.
 * Повреждённый курсор отклоняется до обращения к источнику страницы.
 */
function decode(text: string): Cursor {
  let cursor: unknown;
  try {
    const [body, checksum, extra] = text.split(".");
    const json = Buffer.from(body ?? "", "base64url").toString("utf8");
    if (extra || checksum !== fingerprint(json).slice(0, CURSOR_CHECKSUM_LENGTH)) {
      throw new CliUsageError(paginationMessages.invalidCursor, "INVALID_CURSOR");
    }
    cursor = JSON.parse(json);
  } catch (cause) {
    if (cause instanceof CliUsageError) {
      throw cause;
    }
    throw new CliUsageError(paginationMessages.invalidCursor, "INVALID_CURSOR", { cause });
  }
  if (!isCursor(cursor)) {
    throw new CliUsageError(paginationMessages.invalidCursor, "INVALID_CURSOR");
  }
  return cursor;
}

/**
 * Проверяет принадлежность курсора запросу и неизменность поколения до чтения окна.
 * Явный --limit должен совпадать с первой страницей; неявный размер наследуется из курсора.
 */
function checkCursor(
  previous: Cursor | undefined,
  query: string,
  options: PaginationOptions,
): void {
  if (!previous) {
    return;
  }
  if (
    previous.context !== options.context ||
    previous.query !== query ||
    (options.explicitLimit && previous.limit !== options.limit)
  ) {
    throw new CliUsageError(paginationMessages.mismatchedCursor, "INVALID_CURSOR");
  }
  if (previous.generation !== options.generation) {
    throw new RelayError("SNAPSHOT_CONFLICT", paginationMessages.changedSnapshot, 4);
  }
}

/**
 * Проверяет курсор и читает единственное окно источника, не изменяя переданный массив.
 * Вызывающий код удерживает общий снимок для generation, total и items. Ленивый источник
 * получает offset/limit для ограничения запроса; массив уже полностью вычислен до вызова.
 */
export function paginate<T>(source: PageSource<T>, options: PaginationOptions): Paginated<T> {
  const query = fingerprint(options.query);
  const previous = options.cursor ? decode(options.cursor) : undefined;
  checkCursor(previous, query, options);
  const offset = previous?.offset ?? 0;
  const limit = previous?.limit ?? options.limit;
  const selection =
    typeof source === "function"
      ? source({ offset, limit })
      : { items: source.slice(offset, offset + limit), total: source.length };
  const nextCursor =
    offset + limit < selection.total
      ? encode({
          version: CURSOR_VERSION,
          context: options.context,
          query,
          generation: options.generation,
          offset: offset + limit,
          limit,
        })
      : null;
  return {
    items: selection.items,
    page: {
      count: selection.items.length,
      total: selection.total,
      limit,
      nextCursor,
      nextCommand: nextCursor ? options.command(nextCursor, limit) : null,
      consistency: "snapshot",
    },
  };
}
