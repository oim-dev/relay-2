import "reflect-metadata";
import { RequestMethod, type Type } from "@nestjs/common";
import { METHOD_METADATA, MODULE_METADATA, PATH_METADATA } from "@nestjs/common/constants";
import {
  DECORATORS,
  type OpenAPIObject,
  type OperationObject,
  type PathsObject,
} from "@nestjs/swagger";
import { API_CONTROLLERS, ServerModule } from "../../src/server.module";
import type { NestModuleNode } from "./openapi.types";
import { openapiMessages } from "./generation.messages";

const methods = new Map([
  [RequestMethod.GET, "get"],
  [RequestMethod.POST, "post"],
  [RequestMethod.PUT, "put"],
  [RequestMethod.DELETE, "delete"],
  [RequestMethod.PATCH, "patch"],
  [RequestMethod.OPTIONS, "options"],
  [RequestMethod.HEAD, "head"],
] as const);

/**
 * Проверяет reflection boundary, не объявляя содержимое metadata заранее известным DTO.
 */
function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Сужает class reference из metadata Nest; конструктор никогда не вызывается генератором.
 */
function isType(value: unknown): value is Type<unknown> {
  return typeof value === "function" && value.prototype !== undefined;
}

/**
 * Принимает только реально поддерживаемые synchronous imports module graph.
 */
function isModule(value: unknown): value is NestModuleNode {
  return isType(value) || (isObject(value) && isType(value.module));
}

/**
 * Читает metadata-массив без игнорирования изменившегося контракта Nest.
 */
function metadataArray(key: string, target: object): unknown[] {
  const value: unknown = Reflect.getMetadata(key, target);
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new Error(openapiMessages.metadataArray(key));
  }
  return value;
}

/**
 * Обходит настоящую композицию modules, собирая controllers без providers/DI и пользовательского I/O.
 */
function collectControllers(
  node: NestModuleNode,
  visited = new Set<Type<unknown>>(),
): Type<unknown>[] {
  const module = isType(node) ? node : node.module;
  if (visited.has(module)) {
    return [];
  }
  visited.add(module);
  const controllers = [
    ...metadataArray(MODULE_METADATA.CONTROLLERS, module),
    ...(isType(node) ? [] : (node.controllers ?? [])),
  ];
  if (!controllers.every(isType)) {
    throw new Error(openapiMessages.controller(module.name));
  }
  const imports = [
    ...metadataArray(MODULE_METADATA.IMPORTS, module),
    ...(isType(node) ? [] : (node.imports ?? [])),
  ];
  if (!imports.every(isModule)) {
    throw new Error(openapiMessages.moduleImport(module.name));
  }
  return [...controllers, ...imports.flatMap((entry) => collectControllers(entry, visited))];
}

/**
 * Сохраняет явные Swagger tags; неверная форма не превращается в пустую группу.
 */
function tags(target: object): string[] {
  const values = metadataArray(DECORATORS.API_TAGS, target);
  if (!values.every((value): value is string => typeof value === "string")) {
    throw new Error(openapiMessages.tags);
  }
  return values;
}

/**
 * Преобразует поддерживаемый буквальный Nest path в OpenAPI path без изменения сегментов.
 */
function routePath(controller: Type<unknown>, handler: object): string {
  const base: unknown = Reflect.getMetadata(PATH_METADATA, controller);
  const route: unknown = Reflect.getMetadata(PATH_METADATA, handler);
  if (typeof base !== "string" || typeof route !== "string") {
    throw new Error(openapiMessages.routePath(controller.name));
  }
  return `/${[base, route]
    .map((part) => part.replace(/^\/+|\/+$/g, ""))
    .filter(Boolean)
    .join("/")}`.replace(/:([A-Za-z][A-Za-z0-9_]*)/g, "{$1}");
}

/**
 * Читает operationId/summary/tags именно декорированного handler; исключённые endpoints пропускаются.
 */
function swaggerOperation(controller: Type<unknown>, handler: object): OperationObject | undefined {
  const excluded: unknown = Reflect.getMetadata(DECORATORS.API_EXCLUDE_ENDPOINT, handler);
  if (isObject(excluded) && excluded.disable === true) {
    return undefined;
  }
  const metadata: unknown = Reflect.getMetadata(DECORATORS.API_OPERATION, handler);
  if (!isObject(metadata) || typeof metadata.operationId !== "string") {
    throw new Error(openapiMessages.operationId(controller.name));
  }
  return {
    operationId: metadata.operationId,
    ...(typeof metadata.summary === "string" && metadata.summary !== ""
      ? { summary: metadata.summary }
      : {}),
    tags: [...tags(controller), ...tags(handler)],
    responses: {},
  };
}

/**
 * Собирает пути из реальных Nest decorators; коллизии методов/путей отклоняются до генерации SDK.
 */
function controllerPaths(controllers: readonly Type<unknown>[]): PathsObject {
  const paths: PathsObject = {};
  for (const controller of controllers) {
    const prototype: object = controller.prototype;
    for (const name of Object.getOwnPropertyNames(prototype)) {
      const handler: unknown = Object.getOwnPropertyDescriptor(prototype, name)?.value;
      if (name === "constructor" || typeof handler !== "function") {
        continue;
      }
      const method: unknown = Reflect.getMetadata(METHOD_METADATA, handler);
      if (method === undefined) {
        continue;
      }
      const operation = swaggerOperation(controller, handler);
      if (operation === undefined) {
        continue;
      }
      const entry = [...methods].find(([value]) => value === method);
      if (entry === undefined) {
        throw new Error(openapiMessages.method(`${controller.name}.${name}`));
      }
      const path = routePath(controller, handler);
      operation.parameters = [...path.matchAll(/\{([^}]+)\}/g)].map((match) => ({
        name: match[1] ?? "",
        in: "path",
        required: true,
        schema: { type: "string", minLength: 1 },
      }));
      const item = paths[path] ?? {};
      if (item[entry[1]] !== undefined) {
        throw new Error(openapiMessages.duplicateRoute(entry[1], path));
      }
      item[entry[1]] = operation;
      paths[path] = item;
    }
  }
  return paths;
}

/**
 * Возвращает Swagger-источник настоящего ServerModule по reflection без DI/constructor/bind.
 * Конфигурация передаётся register лишь как metadata; Runtime и БД не вызываются.
 */
export function createSwaggerDocument(): OpenAPIObject {
  const controllers = collectControllers(
    ServerModule.register({
      runtime: { cwd: "/__relay_openapi_metadata__" },
      actor: "OpenAPI",
      version: "2.0.0",
    }),
  );
  if (
    controllers.length !== API_CONTROLLERS.length ||
    API_CONTROLLERS.some((controller) => !controllers.includes(controller))
  ) {
    throw new Error(openapiMessages.controllers);
  }
  return {
    openapi: "3.1.0",
    info: { title: "Relay REST API", version: "2.0.0" },
    paths: controllerPaths(controllers),
  };
}
