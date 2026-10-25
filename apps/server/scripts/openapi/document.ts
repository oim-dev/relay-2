import type { OpenAPIObject, ReferenceObject } from "@nestjs/swagger";
import { HTTP_OPERATIONS } from "../../src/http/operations";
import type { HttpOperationName } from "../../src/http/operations.types";
import {
  assertSchemaReferences,
  rewriteSchemaReferences,
  schemaIdentifiers,
} from "./schema-references";
import type { ContractSchemaCatalog, GeneratedOpenApiDocument } from "./openapi.types";
import { queryParameters } from "./query-parameters";
import { openapiMessages } from "./generation.messages";

const methods = ["get", "put", "post", "delete", "options", "head", "patch", "trace"] as const;

/**
 * Сужает фактический operationId к единственному каталогу, который также используется Nest decorator.
 */
function isHttpOperation(name: string): name is HttpOperationName {
  return Object.hasOwn(HTTP_OPERATIONS, name);
}

/**
 * Получает именованный DTO из сгенерированного Contracts каталога без свободного object-any.
 */
function contractReference(
  schemas: ContractSchemaCatalog["operations"],
  name: string,
): ReferenceObject {
  const schema = schemas[name];
  if (typeof schema !== "object" || typeof schema.$ref !== "string") {
    throw new Error(openapiMessages.missingSchema(name));
  }
  return { $ref: schema.$ref };
}

/**
 * Дополняет настоящий Swagger document точными Contracts DTO. Набор методов/путей
 * берётся из реальных контроллеров; рассогласование с единым route decorator catalog — ошибка.
 * Функция чистая: не создаёт Nest приложение, не открывает проекты и не пишет файлы.
 */
export function assembleOpenApiDocument(
  source: OpenAPIObject,
  catalog: ContractSchemaCatalog,
): GeneratedOpenApiDocument {
  const document = structuredClone(source);
  const found = new Set<string>();
  for (const [path, item] of Object.entries(document.paths)) {
    for (const method of methods) {
      const operation = item[method];
      if (operation === undefined) {
        continue;
      }
      const name = operation.operationId;
      if (name === undefined || found.has(name)) {
        throw new Error(openapiMessages.duplicateOperation(method, path));
      }
      found.add(name);
      if (name === "events") {
        Object.assign(operation, {
          "x-relay-event-schema": contractReference(catalog.operations, "projectEvent").$ref,
        });
        operation.responses = {
          "200": {
            description:
              "SSE: connected/changed/storage-error/heartbeat; reconnect инвалидирует кеш",
            content: { "text/event-stream": { schema: { type: "string" } } },
          },
        };
        continue;
      }
      if (name === "openapi") {
        operation.responses = {
          "200": {
            description: "Этот документ OpenAPI 3.1",
            content: { "application/json": { schema: { type: "object" } } },
          },
        };
        continue;
      }
      if (!isHttpOperation(name)) {
        throw new Error(openapiMessages.unknownOperation(name));
      }
      const definition = HTTP_OPERATIONS[name];
      if (definition.path !== path || definition.method.toLowerCase() !== method) {
        throw new Error(openapiMessages.routeMismatch(name));
      }
      operation.parameters = [...(operation.parameters ?? []), ...queryParameters(name)];
      operation.responses = {
        "200": {
          description: "Результат текущего Core/Runtime сценария",
          content: {
            "application/json": { schema: contractReference(catalog.successResponses, name) },
          },
        },
        ...Object.fromEntries(
          [400, 403, 404, 409, 413, 415, 500, 503].map((status) => [
            String(status),
            { $ref: "#/components/responses/Error" },
          ]),
        ),
      };
      if ("body" in definition) {
        operation.requestBody = {
          required: true,
          content: {
            "application/json": { schema: contractReference(catalog.operations, definition.body) },
          },
        };
      }
    }
  }
  for (const name of Object.keys(HTTP_OPERATIONS)) {
    if (!found.has(name)) {
      throw new Error(openapiMessages.missingOperation(name));
    }
  }
  for (const name of Object.keys(document.components?.schemas ?? {})) {
    if (Object.hasOwn(catalog.schema.definitions, name)) {
      throw new Error(openapiMessages.duplicateComponent(name));
    }
  }
  const definitions = { ...catalog.schema.definitions, ...document.components?.schemas };
  const names = schemaIdentifiers(definitions);
  const result: GeneratedOpenApiDocument = {
    ...document,
    openapi: "3.1.0",
    components: {
      ...document.components,
      schemas: Object.fromEntries(
        Object.entries(definitions).map(([name, schema]) => [names.get(name) ?? name, schema]),
      ),
      responses: {
        ...document.components?.responses,
        Error: {
          description: "Предметный либо транспортный отказ",
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["ok", "error"],
                properties: {
                  ok: { type: "boolean", enum: [false] },
                  error: { $ref: "#/components/schemas/HttpError" },
                },
                additionalProperties: false,
              },
            },
          },
        },
      },
    },
  };
  const rewritten = rewriteSchemaReferences(result, names, "components");
  assertSchemaReferences(rewritten);
  return rewritten;
}
