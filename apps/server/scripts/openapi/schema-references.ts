import { createHash } from "node:crypto";
import { openapiMessages } from "./generation.messages";

/**
 * Сужает JSON-объект, оставляя его значения непроверенными до обхода конкретного ключа.
 */
function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Создаёт стабильное имя компонента из имени TypeScript. Суффикс сложных типов
 * различает generics/literal unions, которые обычная очистка превращает в одно имя.
 */
export function schemaIdentifier(name: string): string {
  if (/^[A-Za-z][A-Za-z0-9_]*$/.test(name)) {
    return name;
  }
  const words = name.replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  const prefix = /^[A-Za-z]/.test(words) ? words : `Schema_${words}`;
  return `${prefix}_${createHash("sha256").update(name).digest("hex").slice(0, 12)}`;
}

/**
 * Декодирует URI fragment и RFC6901 pointer один раз. Percent encoding из upstream
 * generator не переносится в имена OpenAPI components.
 */
function pointerSegments(reference: string): string[] {
  if (!reference.startsWith("#/")) {
    throw new Error(openapiMessages.localReference(reference));
  }
  return decodeURIComponent(reference.slice(2))
    .split("/")
    .map((segment) => segment.replaceAll("~1", "/").replaceAll("~0", "~"));
}

/**
 * Извлекает точное имя definition из корневой ссылки TypeScript generator.
 * Подсхемы и внешние ссылки здесь недопустимы: alias должен адресовать целый компонент.
 */
export function definitionReferenceName(reference: string): string {
  const segments = pointerSegments(reference);
  if (segments.length !== 2 || segments[0] !== "definitions" || segments[1] === undefined) {
    throw new Error(openapiMessages.unknownComponent(reference));
  }
  return segments[1];
}

/**
 * Кодирует только синтаксис JSON Pointer; простые component identifiers не требуют URI encoding.
 */
function pointer(segments: readonly string[]): string {
  return `#/${segments.map((segment) => segment.replaceAll("~", "~0").replaceAll("/", "~1")).join("/")}`;
}

/**
 * Проверяет уникальность конечных имён до изменения ссылок. Коллизия — ошибка генерации,
 * а не произвольный выбор компонента с последующей потерей типов в SDK.
 */
export function schemaIdentifiers(
  definitions: Readonly<Record<string, unknown>>,
  preferred: ReadonlyMap<string, string> = new Map(),
): ReadonlyMap<string, string> {
  const names = new Map<string, string>();
  const used = new Set<string>();
  for (const name of Object.keys(definitions)) {
    const identifier = preferred.get(name) ?? schemaIdentifier(name);
    if (used.has(identifier)) {
      throw new Error(openapiMessages.nameCollision(identifier));
    }
    names.set(name, identifier);
    used.add(identifier);
  }
  return names;
}

/**
 * Переписывает ссылки в копии документа, не меняя исходный Swagger/Contracts объект.
 * Работа ограничена настоящими schema $ref; пользовательские examples/default/const/enum
 * могут содержать буквальные $ref локальных команд и не интерпретируются как JSON Pointer.
 */
export function rewriteSchemaReferences<T>(
  value: T,
  names: ReadonlyMap<string, string>,
  destination: "definitions" | "components",
): T {
  const result = structuredClone(value);
  visitReferences(result, (reference) => {
    const segments = pointerSegments(reference);
    const definition = segments[0] === "definitions";
    const component = segments[0] === "components" && segments[1] === "schemas";
    if (!definition && !component) {
      return reference;
    }
    const index = definition ? 1 : 2;
    const oldName = segments[index];
    const name = oldName === undefined ? undefined : names.get(oldName);
    if (name === undefined) {
      throw new Error(openapiMessages.unknownComponent(reference));
    }
    const prefix = destination === "definitions" ? ["definitions"] : ["components", "schemas"];
    return pointer([...prefix, name, ...segments.slice(index + 1)]);
  });
  return result;
}

/**
 * Обходит схему и её structural children; ключи данных не считаются схемами.
 */
function visitReferences(
  value: unknown,
  rewrite: (reference: string) => string,
  visited = new WeakSet<object>(),
): void {
  if (value === null || typeof value !== "object" || visited.has(value)) {
    return;
  }
  visited.add(value);
  if (Array.isArray(value)) {
    for (const entry of value) {
      visitReferences(entry, rewrite, visited);
    }
    return;
  }
  if (!isObject(value)) {
    return;
  }
  if (typeof value.$ref === "string") {
    value.$ref = rewrite(value.$ref);
  }
  for (const [key, child] of Object.entries(value)) {
    if (["properties", "definitions", "$defs", "schemas"].includes(key) && isObject(child)) {
      for (const entry of Object.values(child)) {
        visitReferences(entry, rewrite, visited);
      }
      continue;
    }
    if (!["$ref", "examples", "example", "default", "const", "enum"].includes(key)) {
      visitReferences(child, rewrite, visited);
    }
  }
}

/**
 * Отвергает все висячие локальные ссылки финального документа до записи output.
 * Это структурная проверка спецификации, а не валидация пользовательских команд.
 */
export function assertSchemaReferences(document: unknown): void {
  visitReferences(structuredClone(document), (reference) => {
    let target: unknown = document;
    for (const segment of pointerSegments(reference)) {
      if (
        Array.isArray(target) &&
        /^(?:0|[1-9][0-9]*)$/.test(segment) &&
        Object.hasOwn(target, segment)
      ) {
        target = target[Number(segment)];
        continue;
      }
      if (!isObject(target) || !Object.hasOwn(target, segment)) {
        throw new Error(openapiMessages.danglingReference(reference));
      }
      target = target[segment];
    }
    return reference;
  });
}
