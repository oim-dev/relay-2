import { RelayError, ENTITY_PAGE_SIZE } from "@relay/contracts";
import type { ProjectStore } from "@relay/storage";
import type { ViewPageInput } from "./view-page.types";
import { viewPageMessages } from "./view-page.messages";

/**
 * Проверяет закрытую форму query до чтения metadata; отсутствующие поля не превращаются в null.
 */
export function viewQuery(
  value: unknown,
  fields: readonly string[],
): Readonly<Record<string, unknown>> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !fields.includes(key))
  ) {
    throw new RelayError("INVALID_ARGUMENT", viewPageMessages.input, 2);
  }
  // Проверена только объектная форма; каждое значение далее проверяет свой parser.
  return value as Readonly<Record<string, unknown>>;
}

/**
 * Проверяет целые безопасные границы окна и обязательное поколение продолжения.
 */
export function viewPage(input: Readonly<Record<string, unknown>>): ViewPageInput {
  const offset = input.offset === undefined ? 0 : input.offset;
  const limit = input.limit === undefined ? 50 : input.limit;
  const generation = input.generation;
  if (
    typeof offset !== "number" ||
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    typeof limit !== "number" ||
    !Number.isSafeInteger(limit) ||
    limit < ENTITY_PAGE_SIZE.min ||
    limit > ENTITY_PAGE_SIZE.max ||
    (generation !== undefined &&
      (typeof generation !== "number" || !Number.isSafeInteger(generation) || generation < 0)) ||
    (offset > 0 && generation === undefined)
  ) {
    throw new RelayError("INVALID_ARGUMENT", viewPageMessages.page, 2);
  }
  return { offset, limit, ...(generation === undefined ? {} : { generation }) };
}

/**
 * Сверяет исходное поколение внутри snapshot до загрузки metadata и возвращает текущее.
 */
export function viewGeneration(db: ProjectStore, expected: number | undefined): number {
  const actual = db.getGeneration();
  if (expected !== undefined && expected !== actual) {
    throw new RelayError("PAGE_CHANGED", viewPageMessages.changed, 4, { expected, actual });
  }
  return actual;
}

/**
 * Сохраняет пользовательскую ссылку/строку фильтра; null и нестроковый ввод отклоняет.
 */
export function viewText(value: unknown): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string" || value.length === 0) {
    throw new RelayError("INVALID_ARGUMENT", viewPageMessages.text, 2);
  }
  return value;
}
