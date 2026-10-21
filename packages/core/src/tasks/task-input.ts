/**
 * Граница внешнего ввода задач: проверяет форму и возвращает предметные команды.
 * Разрешение ссылок и проверки текущего состояния выполняются внутри транзакции сервиса.
 */
import { randomUUID } from "node:crypto";
import {
  RelayError,
  TASK_COLUMNS,
  validateActor,
  type TaskColumn,
  type TaskCriterion,
  type WriteOptions,
} from "@relay/contracts";
import {
  TASK_CRITERION_FIELDS,
  TASK_CRITERION_TEXT_RULES,
  TASK_FILTER_VALUES,
  TASK_LIMITS,
} from "./task-constants";
import type {
  CreateTaskInput,
  MoveTaskInput,
  TaskCriterionContent,
  TaskFilterInput,
  TaskLinkChange,
  TaskTargetFilter,
  UpdateTaskInput,
} from "./task-input.types";
import { taskCriterionLabels, taskLabels, taskMessages } from "./task-messages";
import { taskTextViolation } from "./task-text";
import type { TaskTextOptions } from "./task-text.types";

/**
 * Отказывает некорректной команде задачи с устойчивым кодом входной ошибки.
 */
export function invalid(message: string): never {
  throw new RelayError("INVALID_ARGUMENT", message, 2);
}

/**
 * Сужает внешнее значение до словаря полей, не утверждая форму самих значений.
 */
function isObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Проверяет обычный объект и список допустимых полей; null разрешён только у parent.
 * Возвращаемый словарь используется лишь декодерами этой границы, а не сценариями записи.
 */
export function object(
  value: unknown,
  fields: readonly string[],
  label: string,
): Readonly<Record<string, unknown>> {
  if (!isObject(value)) {
    invalid(taskMessages.expectedObject(label));
  }
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
    invalid(taskMessages.expectedPlainObject(label));
  }
  for (const key of Object.keys(value)) {
    if (!fields.includes(key)) {
      invalid(taskMessages.unknownField(label, key));
    }
    if (value[key] === undefined) {
      invalid(taskMessages.undefinedField(label, key));
    }
    if (value[key] === null && key !== "parent") {
      invalid(taskMessages.nullField(label, key));
    }
  }
  return value;
}

/**
 * Проверяет текст без нормализации; именованные ограничения различают пустоту и переносы строк.
 */
export function text(
  value: unknown,
  name: string,
  maximum: number,
  options: TaskTextOptions = {},
): string {
  if (typeof value !== "string") {
    invalid(taskMessages.invalidText(name, maximum));
  }
  switch (taskTextViolation(value, maximum, options)) {
    case "format":
      return invalid(taskMessages.invalidText(name, maximum));
    case "singleLine":
      return invalid(taskMessages.singleLine(name));
    case "required":
      return invalid(taskMessages.requiredText(name));
    case undefined:
      return value;
  }
}

/**
 * Проверяет синтаксис непустой ссылки; её вид и существование проверяет EntityService.
 */
export function reference(value: unknown, name: string): string {
  const result = text(value, name, TASK_LIMITS.reference, { singleLine: true, required: true });
  if (result !== result.trim() || /\p{Cc}/u.test(result)) {
    invalid(taskMessages.invalidReference(name));
  }
  return result;
}

/**
 * Возвращает поддерживаемую колонку без приведения непроверенного значения к TaskColumn.
 */
export function column(value: unknown): TaskColumn {
  const result = TASK_COLUMNS.find((item) => item === value);
  if (result === undefined) {
    invalid(taskMessages.unknownColumn(TASK_COLUMNS));
  }
  return result;
}

/**
 * Выбирает проверенный литерал из предметного перечисления.
 */
export function choice<T extends string>(value: unknown, variants: readonly T[], name: string): T {
  const result = variants.find((item) => item === value);
  if (result === undefined) {
    invalid(taskMessages.invalidChoice(name, variants));
  }
  return result;
}

/**
 * Проверяет размер массива; пропуски становятся undefined и проходят проверку элементов.
 */
export function array(value: unknown, name: string, maximum: number): unknown[] {
  if (!Array.isArray(value) || value.length > maximum) {
    invalid(taskMessages.invalidArray(name, maximum));
  }
  return Array.from(value);
}

/**
 * Проверяет список пользовательских ссылок; дубли по постоянным ID проверяются после разрешения.
 */
function references(value: unknown, name: string, maximum: number): string[] {
  return array(value, name, maximum).map((item) => reference(item, name));
}

/**
 * Проверяет текст критерия по общему с хранением правилу, сохраняя INVALID_ARGUMENT для ввода.
 */
export function criterionText(value: unknown, field: keyof TaskCriterionContent): string {
  const rule = TASK_CRITERION_TEXT_RULES[field];
  return text(value, taskCriterionLabels[field], rule.maximum, rule);
}

/**
 * Проверяет полное содержание критерия; заголовок обязателен, остальные тексты по умолчанию пусты.
 */
export function criterionContent(input: unknown): TaskCriterionContent {
  const value = object(input, TASK_CRITERION_FIELDS, taskLabels.criterion);
  return {
    title: criterionText(value.title, "title"),
    summary: criterionText(value.summary ?? "", "summary"),
    description: criterionText(value.description ?? "", "description"),
  };
}

/**
 * Подготавливает невыполненный критерий с новым UUID, не записывая его в проект.
 */
export function newCriterion(input: unknown): TaskCriterion {
  return {
    id: randomUUID(),
    ...criterionContent(input),
    completed: false,
    completedAt: null,
    completedBy: null,
  };
}

/**
 * Декодирует создание задачи и применяет значения по умолчанию до разрешения ссылок.
 */
export function parseCreateTask(input: unknown): CreateTaskInput {
  const value = object(
    input,
    [
      "board",
      "title",
      "description",
      "column",
      "parent",
      "dependencies",
      "related",
      "targets",
      "acceptanceCriteria",
    ],
    taskLabels.creation,
  );
  return {
    board: reference(value.board ?? "BOARD-PRODUCT", taskLabels.board),
    title: text(value.title ?? "", taskLabels.title, TASK_LIMITS.title, { singleLine: true }),
    description: text(value.description ?? "", taskLabels.description, TASK_LIMITS.description),
    column: column(value.column ?? "inbox"),
    parent:
      value.parent === undefined || value.parent === null
        ? null
        : reference(value.parent, taskLabels.parent),
    dependencies: references(value.dependencies ?? [], taskLabels.dependencies, TASK_LIMITS.links),
    related: references(value.related ?? [], taskLabels.related, TASK_LIMITS.links),
    targets: references(value.targets ?? [], taskLabels.targets, TASK_LIMITS.targets),
    acceptanceCriteria: array(
      value.acceptanceCriteria ?? [],
      taskLabels.criteria,
      TASK_LIMITS.criteria,
    ).map(newCriterion),
  };
}

/**
 * Декодирует непустую правку содержания; непереданные поля остаются undefined.
 */
export function parseUpdateTask(input: unknown): UpdateTaskInput {
  const value = object(input, ["title", "description", "targets"], taskLabels.update);
  if (Object.keys(value).length === 0) {
    invalid(taskMessages.emptyUpdate);
  }
  return {
    title:
      value.title === undefined
        ? undefined
        : text(value.title, taskLabels.title, TASK_LIMITS.title, { singleLine: true }),
    description:
      value.description === undefined
        ? undefined
        : text(value.description, taskLabels.description, TASK_LIMITS.description),
    targets:
      value.targets === undefined
        ? undefined
        : references(value.targets, taskLabels.targets, TASK_LIMITS.targets),
  };
}

/**
 * Декодирует перенос, требуя хотя бы доску или колонку.
 */
export function parseMoveTask(input: unknown): MoveTaskInput {
  const value = object(input, ["board", "column"], taskLabels.move);
  if (Object.keys(value).length === 0) {
    invalid(taskMessages.emptyMove);
  }
  return {
    board: value.board === undefined ? undefined : reference(value.board, taskLabels.board),
    column: value.column === undefined ? undefined : column(value.column),
  };
}

/**
 * Проверяет автора и ожидаемую ревизию содержания без обращения к хранилищу.
 */
export function validateTaskWriteOptions(options: WriteOptions): void {
  object(options, ["actor", "ifRevision"], taskLabels.writeOptions);
  validateActor(options.actor);
  if (!Number.isSafeInteger(options.ifRevision) || options.ifRevision < 1) {
    invalid(taskMessages.revisionRequired);
  }
}

/**
 * Преобразует публичный флаг удаления в предметное действие над связью.
 */
export function parseTaskLink(
  field: TaskLinkChange["field"],
  target: unknown,
  remove: unknown,
): TaskLinkChange {
  if (typeof remove !== "boolean") {
    invalid(taskMessages.removeBoolean);
  }
  return {
    field,
    action: remove ? "remove" : "add",
    target: reference(target, taskLabels.linkedTask),
  };
}

/**
 * Нормализует альтернативные поля цели, сохраняя различие прямого и расширенного поиска.
 */
function parseTargetFilter(value: Readonly<Record<string, unknown>>): TaskTargetFilter | undefined {
  if (value.target !== undefined && value.productTarget !== undefined) {
    invalid(taskMessages.targetAliases);
  }
  if (value.target !== undefined) {
    return { reference: reference(value.target, taskLabels.target), scope: "direct" };
  }
  if (value.productTarget !== undefined) {
    return { reference: reference(value.productTarget, taskLabels.target), scope: "product" };
  }
  return undefined;
}

/**
 * Декодирует фильтры без чтения БД; пустоту исходного запроса сохраняет для SQL-пагинации.
 */
export function parseTaskFilters(input: unknown): TaskFilterInput {
  const value = object(
    input,
    [
      "board",
      "column",
      "parent",
      "parentId",
      "completion",
      "searchIn",
      "q",
      "readiness",
      "target",
      "productTarget",
    ],
    taskLabels.filters,
  );
  if (value.parent !== undefined && value.parentId !== undefined) {
    invalid(taskMessages.parentAliases);
  }
  let parent: TaskFilterInput["parent"];
  const parentValue = value.parent !== undefined ? value.parent : value.parentId;
  if (parentValue === null || parentValue === undefined) {
    parent = parentValue;
  } else {
    parent = reference(parentValue, taskLabels.parent);
  }
  return {
    board: value.board === undefined ? undefined : reference(value.board, taskLabels.board),
    column: value.column === undefined ? undefined : column(value.column),
    parent,
    completion:
      value.completion === undefined
        ? undefined
        : choice(value.completion, TASK_FILTER_VALUES.completion, taskLabels.completion),
    searchIn:
      value.searchIn === undefined
        ? "all"
        : choice(value.searchIn, TASK_FILTER_VALUES.searchIn, taskLabels.searchIn),
    query:
      value.q === undefined
        ? ""
        : text(value.q, taskLabels.search, TASK_LIMITS.search).toLocaleLowerCase(),
    readiness:
      value.readiness === undefined
        ? undefined
        : choice(value.readiness, TASK_FILTER_VALUES.readiness, taskLabels.readiness),
    target: parseTargetFilter(value),
    unfiltered: Object.keys(value).length === 0,
  };
}
