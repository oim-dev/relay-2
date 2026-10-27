import {
  ENTITY_PAGE_SORTS,
  ENTITY_READ_SIZE,
  RelayError,
  validateEntityPageRequest,
} from "@relay/contracts";
import { object, parseTaskFilters, reference } from "./task-input";
import type { TaskViewInput } from "./task-views.types";
import { taskViewMessages } from "./task-views.messages";

const taskFields = [
  "board",
  "column",
  "parentId",
  "q",
  "searchIn",
  "target",
  "productTarget",
  "completion",
  "readiness",
];
const pageFields = ["offset", "limit", "sort", "generation", "ref", "refs"];

/**
 * Проверяет integer транспортного ввода без приведения строк или округления.
 */
function integer(value: unknown): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new RelayError("INVALID_ARGUMENT", taskViewMessages.integer, 2);
  }
  return value;
}

/**
 * Декодирует страницу, а текущие предметные фильтры передаёт единственному владельцу.
 * Пропуск generation допустим только в начале; произвольные неизвестные поля отвергаются.
 */
export function parseTaskViewInput(input: unknown, candidates: boolean): TaskViewInput {
  const value = object(
    input,
    [...taskFields, ...pageFields, ...(candidates ? ["plan", "stageId", "availableOnly"] : [])],
    taskViewMessages.query,
  );
  const sort = ENTITY_PAGE_SORTS.find((item) => item === (value.sort ?? "key"));
  if (sort === undefined) {
    throw new RelayError("INVALID_ARGUMENT", taskViewMessages.sort, 2);
  }
  const page = { offset: integer(value.offset) ?? 0, limit: integer(value.limit) ?? 40, sort };
  validateEntityPageRequest(page);
  const generation = integer(value.generation);
  if (page.offset > 0 && generation === undefined) {
    throw new RelayError("INVALID_ARGUMENT", taskViewMessages.generationRequired, 2);
  }
  if (value.availableOnly !== undefined && typeof value.availableOnly !== "boolean") {
    throw new RelayError("INVALID_ARGUMENT", taskViewMessages.availableOnly, 2);
  }
  if ((value.plan === undefined) !== (value.stageId === undefined)) {
    throw new RelayError("INVALID_ARGUMENT", taskViewMessages.stagePair, 2);
  }
  let refs: string[] | undefined;
  if (value.refs !== undefined) {
    if (
      value.ref !== undefined ||
      !Array.isArray(value.refs) ||
      value.refs.length < ENTITY_READ_SIZE.min ||
      value.refs.length > ENTITY_READ_SIZE.max
    ) {
      throw new RelayError("INVALID_ARGUMENT", taskViewMessages.references, 2);
    }
    refs = value.refs.map((item) => reference(item, "refs"));
  }
  return {
    filters: parseTaskFilters(
      Object.fromEntries(Object.entries(value).filter(([key]) => taskFields.includes(key))),
    ),
    page,
    generation,
    refs,
    ref: value.ref === undefined ? undefined : reference(value.ref, "ref"),
    plan: value.plan === undefined ? undefined : reference(value.plan, "plan"),
    stageId: value.stageId === undefined ? undefined : reference(value.stageId, "stageId"),
    availableOnly: value.availableOnly === true,
  };
}
