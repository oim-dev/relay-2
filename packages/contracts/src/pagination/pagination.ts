import { RelayError } from "../errors/relay-error";
import { ENTITY_PAGE_SIZE, ENTITY_PAGE_SORTS } from "./pagination.constants";
import { paginationMessages } from "./pagination.messages";
import type { EntityPageRequest } from "./pagination.types";

/**
 * Проверяет границы и сортировку страницы без изменения переданного запроса.
 * Применяет единые правила к SQL-спискам и вычисленным в Core составам.
 *
 * @throws RelayError с кодом INVALID_ARGUMENT при неверном окне списка.
 */
export function validateEntityPageRequest(value: EntityPageRequest): void {
  if (
    !value ||
    !Number.isSafeInteger(value.offset) ||
    value.offset < 0 ||
    !Number.isSafeInteger(value.limit) ||
    value.limit < ENTITY_PAGE_SIZE.min ||
    value.limit > ENTITY_PAGE_SIZE.max ||
    !ENTITY_PAGE_SORTS.includes(value.sort)
  ) {
    throw new RelayError("INVALID_ARGUMENT", paginationMessages.invalidRequest, 2);
  }
}
