import { createParamDecorator, type ExecutionContext } from "@nestjs/common";
import { RelayError } from "@relay/contracts";
import type { FastifyRequest } from "fastify";
import { httpMessages } from "./http.messages";

/**
 * Возвращает исходные query values, сохраняя повторы и точные UTF-16 строки URL decoder.
 */
export const QueryInput = createParamDecorator(
  (_data: unknown, context: ExecutionContext): URLSearchParams => {
    const request = context.switchToHttp().getRequest<FastifyRequest>();
    return new URL(request.url, "http://localhost").searchParams;
  },
);

/**
 * Сообщает отказ внешнего ввода с точным именем неверного поля.
 */
export function invalidInput(field: string): never {
  throw new RelayError("INVALID_ARGUMENT", httpMessages.input, 2, { field });
}

/**
 * Отсутствующее значение сохраняется как null; неоднозначный повтор отвергается.
 */
export function single(query: URLSearchParams, name: string): string | null {
  if (query.getAll(name).length > 1) {
    invalidInput(name);
  }
  return query.get(name);
}

/**
 * Принимает только буквальные boolean, без truthiness или coercion.
 */
export function booleanQuery(query: URLSearchParams, name: string): boolean | undefined {
  const value = single(query, name);
  if (value === null) {
    return undefined;
  }
  if (value !== "true" && value !== "false") {
    invalidInput(name);
  }
  return value === "true";
}

/**
 * Декодирует безопасный неотрицательный integer, не принимая пустую строку и экспоненту.
 */
export function integerQuery(query: URLSearchParams, name: string): number | undefined {
  const value = single(query, name);
  if (value === null) {
    return undefined;
  }
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) {
    invalidInput(name);
  }
  return Number(value);
}

/**
 * Передаёт фильтры Core с точными типами; root=true означает parent:null, false не фильтрует.
 * Набор полей проверяется предметным сервисом. Прототип объекта через query не изменяется.
 */
export function filters(
  query: URLSearchParams,
  excluded: readonly string[] = [],
  parentRoot = false,
): Record<string, unknown> {
  const entries = [...new Set(query.keys())].filter((key) => !excluded.includes(key));
  const result = Object.fromEntries(
    entries.map((key) => [
      key,
      ["active", "pinned", "archived", "unfinished"].includes(key)
        ? booleanQuery(query, key)
        : single(query, key),
    ]),
  );
  if (parentRoot && Object.hasOwn(result, "root")) {
    if (Object.hasOwn(result, "parent") || Object.hasOwn(result, "parentId")) {
      invalidInput("root");
    }
    const root = booleanQuery(query, "root");
    delete result.root;
    if (root === true) {
      result.parent = null;
    }
  }
  return result;
}
