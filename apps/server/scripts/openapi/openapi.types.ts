import type { CommandJsonSchema } from "@relay/contracts";
import type { Schema } from "ts-json-schema-generator";
import type {
  OpenAPIObject,
  ComponentsObject,
  SchemaObject,
  ReferenceObject,
} from "@nestjs/swagger";
import type { DynamicModule, Type } from "@nestjs/common";

/**
 * Поддерживаемые узлы реального module graph; deferred/async imports требуют явного нового адаптера.
 */
export type NestModuleNode = Type<unknown> | DynamicModule;

/**
 * Согласованный каталог: JSON Schema для локальных adapters и указатели операций для OpenAPI.
 */
export interface ContractSchemaCatalog {
  /* Полная схема с простыми component-compatible именами и разрешимыми локальными $ref. */
  readonly schema: Omit<Schema, "definitions"> & {
    /* Все определения схем, включая точные операции команд вместо свободного NamedCommand. */
    readonly definitions: Readonly<Record<string, Schema | CommandJsonSchema | boolean>>;
  };
  /* Имена HTTP-сценариев и request DTO из HttpApiSchemas, без отдельного каталога маршрутов. */
  readonly operations: Readonly<Record<string, Schema | boolean>>;
  /* Только успешные ветви HTTP 200; общий operations/schema сохраняет envelopes union. */
  readonly successResponses: Readonly<Record<string, Schema>>;
  /* Соответствие TypeScript имён стабильным простым identifiers. */
  readonly names: ReadonlyMap<string, string>;
}

/**
 * OpenAPI 3.1 расширяет Swagger-декларации схемами JSON Schema (const и boolean schemas).
 * Routes/parameters/operationId сохраняют тип и происхождение настоящего Nest документа.
 */
export type GeneratedOpenApiDocument = Omit<OpenAPIObject, "components"> & {
  /* Компоненты Swagger плюс точные Contracts schemas. */
  readonly components: Omit<ComponentsObject, "schemas"> & {
    /* Замкнутый набор именованных JSON Schema, пригодный для SDK codegen. */
    readonly schemas: Readonly<
      Record<string, Schema | CommandJsonSchema | SchemaObject | ReferenceObject | boolean>
    >;
  };
};
