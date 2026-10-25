import type { Schema } from "ts-json-schema-generator";
import { definitionReferenceName } from "./schema-references";
import { openapiMessages } from "./generation.messages";

/**
 * Разрешает только цепочку aliases, не разворачивая поля и рекурсивные предметные DTO.
 */
function responseDefinition(
  schema: Schema | boolean,
  definitions: Readonly<Record<string, Schema | boolean>>,
): Schema | boolean {
  const visited = new Set<string>();
  let current = schema;
  while (typeof current === "object" && current.$ref !== undefined) {
    const name = definitionReferenceName(current.$ref);
    const next = definitions[name];
    if (visited.has(name) || next === undefined) {
      throw new Error(openapiMessages.unknownComponent(current.$ref));
    }
    visited.add(name);
    current = next;
  }
  return current;
}

/**
 * Выбирает именованную HttpSuccessResponse<T> из общего HttpResponse<T> для статуса 200.
 * Исходные definitions и общий каталог не меняются: process validators сохраняют union.
 * Запросы и SSE без envelope не входят в результат; вызывающий проверяет полноту HTTP readers.
 */
export function successResponseReferences(
  operations: Readonly<Record<string, Schema | boolean>>,
  definitions: Readonly<Record<string, Schema | boolean>>,
): Readonly<Record<string, Schema>> {
  const result: Record<string, Schema> = {};
  for (const [name, schema] of Object.entries(operations)) {
    const response = responseDefinition(schema, definitions);
    if (typeof response !== "object") {
      continue;
    }
    for (const branch of response.anyOf ?? response.oneOf ?? []) {
      const resolved = responseDefinition(branch, definitions);
      const ok = typeof resolved === "object" ? resolved.properties?.ok : undefined;
      if (typeof ok !== "object" || ok.const !== true) {
        continue;
      }
      if (typeof branch !== "object" || branch.$ref === undefined || result[name] !== undefined) {
        throw new Error(openapiMessages.successReference(name));
      }
      result[name] = { $ref: branch.$ref };
    }
  }
  return result;
}
