import { applyDecorators, Get, HttpCode, Post, SetMetadata } from "@nestjs/common";
import { ApiOperation } from "@nestjs/swagger";
import { HTTP_OPERATIONS } from "./operations";
import type { HttpOperationName } from "./operations.types";

/**
 * Ключ reflection metadata для проверки полноты реальных контроллеров.
 */
export const OPERATION_METADATA = "relay:http-operation";

/**
 * Регистрирует Nest route и Swagger operationId из одного независимого wire-каталога.
 * POST возвращает прежний 200; DTO не сериализуется через lossy class-transformer.
 */
export function Operation(name: HttpOperationName): MethodDecorator {
  const entry = HTTP_OPERATIONS[name];
  const path = entry.path.replace(/\{([^}]+)\}/g, ":$1");
  return applyDecorators(
    entry.method === "GET" ? Get(path) : Post(path),
    HttpCode(200),
    ApiOperation({ operationId: name }),
    SetMetadata(OPERATION_METADATA, name),
  );
}
