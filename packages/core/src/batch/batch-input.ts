import {
  BATCH_LIMITS,
  RelayError,
  type BatchReference,
  type BatchRevisionReference,
} from "@relay/contracts";
import { locateBatchError } from "./batch-errors";
import { isWellFormedAddressText } from "../entities/entity-text";
import { batchMessages } from "./batch.messages";
import type {
  BatchActionDescriptor,
  BatchJson,
  BatchObject,
  BatchStep,
  PreparedBatchInput,
} from "./batch.types";

/**
 * Отклоняет форму пакета со стабильным путём проблемного значения.
 */
export function invalidBatch(message: string, path: string): never {
  throw new RelayError("INVALID_ARGUMENT", message, 2, { path });
}

/**
 * Проверяет конечное JSON-дерево и возвращает копию с лексикографическим порядком ключей.
 * Это нормализация идентичности доставки, а не интерполяция или изменение содержания.
 */
export function canonicalBatchJson(
  value: unknown,
  path = "$",
  parents = new Set<object>(),
): BatchJson {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value !== "object" || parents.has(value)) {
    invalidBatch(batchMessages.json, path);
  }
  parents.add(value);
  try {
    if (Array.isArray(value)) {
      return Array.from(value, (entry, index) =>
        canonicalBatchJson(entry, `${path}[${index}]`, parents),
      );
    }
    const object = batchObject(value, path);
    return Object.fromEntries(
      Object.keys(object)
        .sort()
        .map((field) => [field, canonicalBatchJson(object[field], `${path}.${field}`, parents)]),
    );
  } finally {
    parents.delete(value);
  }
}

/**
 * Единожды копирует и сериализует исходный запрос до открытия транзакции писателя.
 * Автор уже проверен вызывающим сценарием. Ограничения пакета проверяются позже,
 * чтобы существующая квитанция по-прежнему читалась до проверки каталога операций.
 */
export function prepareBatchInput(input: unknown, actor: string): PreparedBatchInput {
  const canonical = canonicalBatchJson(input);
  const json = JSON.stringify(canonical);
  return {
    input: canonical,
    inputBytes: new TextEncoder().encode(json).byteLength,
    requestJson: `{"actor":${JSON.stringify(actor)},"input":${json}}`,
  };
}

/**
 * Проверяет обычный объект без утверждения предметного содержания полей.
 */
export function batchObject(value: unknown, path: string): Readonly<Record<string, unknown>> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) ||
    Reflect.ownKeys(value).some((key) => typeof key !== "string")
  ) {
    invalidBatch(batchMessages.object, path);
  }
  // Форма словаря проверена; значения остаются unknown до своего декодера.
  return value as Readonly<Record<string, unknown>>;
}

/**
 * Проверяет точный набор полей на внешней границе, включая вложенные маркеры.
 */
export function batchFields(
  value: unknown,
  allowed: readonly string[],
  path: string,
): Readonly<Record<string, unknown>> {
  const object = batchObject(value, path);
  for (const field of Object.keys(object)) {
    if (!allowed.includes(field)) {
      invalidBatch(batchMessages.unknownField, `${path}.${field}`);
    }
  }
  return object;
}

/**
 * Проверяет UTF-8-представимый адрес, локальное имя или ключ доставки без исправления текста.
 * Markdown и JSON-содержание проверяются отдельно и могут сохранять lone surrogate.
 */
export function batchText(value: unknown, path: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    !isWellFormedAddressText(value) ||
    value.trim() !== value ||
    /\p{Cc}/u.test(value)
  ) {
    invalidBatch(batchMessages.text, path);
  }
  return value;
}

/**
 * Разбирает локальную ссылку либо обычный адрес без обращения к текущим данным проекта.
 */
export function batchReference(value: unknown, path: string): string | BatchReference {
  if (typeof value === "string") {
    return batchText(value, path);
  }
  const object = batchFields(value, ["$ref"], path);
  return { $ref: batchText(object.$ref, `${path}.$ref`) };
}

/**
 * Проверяет положительный явный CAS либо маркер ревизии; владельца проверяет исполнитель.
 */
export function batchRevision(value: unknown, path: string): number | BatchRevisionReference {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 1) {
    return value;
  }
  if (value !== null && typeof value === "object") {
    const object = batchFields(value, ["$revision"], path);
    return { $revision: batchText(object.$revision, `${path}.$revision`) };
  }
  return invalidBatch(batchMessages.revision, path);
}

/**
 * Проверяет оболочку операции и поля каталога без чтения БД; input остаётся границей сервиса.
 */
function parseStep(
  value: unknown,
  index: number,
  catalog: ReadonlyMap<string, BatchActionDescriptor>,
  aliases: Set<string>,
  implicitCreation: boolean,
): BatchStep {
  const path = `operations[${index}]`;
  let op = "";
  try {
    const object = batchObject(value, path);
    op = batchText(object.op, `${path}.op`);
    batchFields(object, ["op", "as", "ref", "ifRevision", "expectedVersion", "input"], path);
    const action = catalog.get(op);
    if (action === undefined) {
      invalidBatch(batchMessages.unknownOperation, `${path}.op`);
    }
    const name = object.as === undefined ? null : batchText(object.as, `${path}.as`);
    if (name !== null && aliases.has(name)) {
      invalidBatch(batchMessages.alias, `${path}.as`);
    }
    if (name !== null) {
      aliases.add(name);
    }
    const input = batchFields(
      Object.hasOwn(object, "input") ? object.input : {},
      action.description.inputFields,
      `${path}.input`,
    );
    const explicitSingleton =
      implicitCreation &&
      object.ref !== undefined &&
      ["project.update", "project.rename", "product.update", "product.rename"].includes(op);
    const ref =
      action.description.ref === "required" || explicitSingleton
        ? batchReference(object.ref, `${path}.ref`)
        : undefined;
    if (ref === undefined && Object.hasOwn(object, "ref")) {
      invalidBatch(batchMessages.unknownField, `${path}.ref`);
    }
    const expectedVersion =
      object.expectedVersion === undefined
        ? undefined
        : batchText(object.expectedVersion, `${path}.expectedVersion`);
    if (expectedVersion !== undefined && action.description.revisionOwner === null) {
      invalidBatch(batchMessages.unknownField, `${path}.expectedVersion`);
    }
    const revision =
      action.description.revisionOwner === null ||
      (object.ifRevision === undefined && expectedVersion !== undefined) ||
      (implicitCreation &&
        object.ifRevision === undefined &&
        (op === "product.create" || op === "implementation.create"))
        ? undefined
        : batchRevision(object.ifRevision, `${path}.ifRevision`);
    if (revision === undefined && Object.hasOwn(object, "ifRevision")) {
      invalidBatch(batchMessages.unknownField, `${path}.ifRevision`);
    }
    // prepareBatchInput уже скопировал и проверил JSON-дерево; batchFields подтвердил объект input.
    return {
      op,
      as: name,
      input: input as BatchObject,
      ...(ref === undefined ? {} : { ref }),
      ...(revision === undefined ? {} : { ifRevision: revision }),
      ...(expectedVersion === undefined ? {} : { expectedVersion }),
    };
  } catch (error) {
    throw locateBatchError(error, index, op);
  }
}

/**
 * Проверяет формат v1 и границы подготовленного пакета без повторной копии и сериализации JSON.
 * Вызывающий сначала проверяет существующую квитанцию; разбор не обращается к БД и не меняет ввод.
 */
export function parseBatch(
  prepared: PreparedBatchInput,
  catalog: ReadonlyMap<string, BatchActionDescriptor>,
  implicitCreation = false,
): readonly BatchStep[] {
  if (prepared.inputBytes > BATCH_LIMITS.inputBytes) {
    invalidBatch(batchMessages.tooLarge, "$");
  }
  const object = batchFields(prepared.input, ["version", "operations"], "$");
  if (object.version !== 1) {
    invalidBatch(batchMessages.version, "version");
  }
  if (
    !Array.isArray(object.operations) ||
    object.operations.length < 1 ||
    object.operations.length > BATCH_LIMITS.operations
  ) {
    invalidBatch(batchMessages.operations, "operations");
  }
  const aliases = new Set<string>();
  return object.operations.map((step, index) =>
    parseStep(step, index, catalog, aliases, implicitCreation),
  );
}
