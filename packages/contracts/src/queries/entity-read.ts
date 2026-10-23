import { RelayError } from "../errors/relay-error";
import { ENTITY_READ_SIZE } from "./entity-read.constants";
import { entityReadMessages } from "./entity-read.messages";
import type { EntityReadOptions } from "./entity-read.types";

/**
 * Проверяет размер и форму запроса без изменения входа и обращения к хранилищу.
 * Неверный запрос даёт INVALID_ARGUMENT; синтаксис отдельных адресов проверяет resolver Core.
 */
export function validateEntityReadRequest(
  refs: readonly string[],
  options: EntityReadOptions = {},
): void {
  if (
    !Array.isArray(refs) ||
    refs.length < ENTITY_READ_SIZE.min ||
    refs.length > ENTITY_READ_SIZE.max ||
    Array.from(refs).some((ref) => typeof ref !== "string")
  ) {
    throw new RelayError("INVALID_ARGUMENT", entityReadMessages.invalidReferences, 2);
  }
  if (
    options === null ||
    typeof options !== "object" ||
    Array.isArray(options) ||
    Object.keys(options).some((field) => field !== "summary") ||
    (options.summary !== undefined && typeof options.summary !== "boolean")
  ) {
    throw new RelayError("INVALID_ARGUMENT", entityReadMessages.invalidOptions, 2);
  }
}
