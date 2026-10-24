import { isEntityKind } from "@relay/contracts";
import { batchObject } from "./batch-input";
import type { BatchStepContext } from "./batch-context";
import type { BatchAddressField, BatchObject } from "./batch.types";

/**
 * Обходит один объявленный путь; * относится только к массиву, а не произвольным полям JSON.
 * Структурированные target проверяются своим вторым путём target.id, без замены всего объекта.
 */
async function resolvePath(
  value: unknown,
  segments: readonly string[],
  field: BatchAddressField,
  path: string,
  context: BatchStepContext,
): Promise<unknown> {
  if (value === undefined || value === null) {
    if (value === null && segments.length === 0) {
      context.commands.target(path, null);
    }
    return value;
  }
  if (segments.length === 0) {
    if (
      field.path.endsWith(".target") &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      !("$ref" in value)
    ) {
      return value;
    }
    return context.address(value, path, field.kinds);
  }
  const [segment, ...rest] = segments;
  if (segment === "*") {
    if (!Array.isArray(value)) {
      return value;
    }
    const result: unknown[] = [];
    for (const [index, item] of value.entries()) {
      result.push(await resolvePath(item, rest, field, `${path}[${index}]`, context));
    }
    return result;
  }
  if (segment === undefined || typeof value !== "object" || Array.isArray(value)) {
    return value;
  }
  const object = batchObject(value, context.path(path));
  if (!Object.hasOwn(object, segment)) {
    return value;
  }
  const selectedField =
    segment === "id" && isEntityKind(object.kind) && field.kinds.includes(object.kind)
      ? { ...field, kinds: [object.kind] }
      : field;
  return {
    ...object,
    [segment]: await resolvePath(
      object[segment],
      rest,
      selectedField,
      `${path}.${segment}`,
      context,
    ),
  };
}

/**
 * Подставляет только объявленные адреса, сохраняя Markdown, пользовательские строки и прочие объекты.
 * Повреждённую форму массива/структуры оставляет предметному декодеру без молчаливого исправления.
 */
export async function resolveBatchInput(
  input: BatchObject,
  fields: readonly BatchAddressField[],
  context: BatchStepContext,
): Promise<Readonly<Record<string, unknown>>> {
  let result: unknown = input;
  for (const field of fields) {
    result = await resolvePath(result, field.path.split("."), field, "input", context);
  }
  return batchObject(result, context.path("input"));
}
