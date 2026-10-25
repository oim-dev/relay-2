import type { HttpApiSchemas, HttpResponse } from "@relay/contracts";

/**
 * Имена JSON endpoints выводятся из переносимого каталога результатов Contracts.
 */
export type HttpOperationName = {
  readonly [K in keyof HttpApiSchemas]: HttpApiSchemas[K] extends HttpResponse<unknown> ? K : never;
}[keyof HttpApiSchemas];

/**
 * Wire-описание, общее для Nest route decorator и генератора OpenAPI/SDK.
 */
export interface HttpOperationDefinition {
  /* Метод реального Nest handler. */
  readonly method: "GET" | "POST";
  /* Полный путь с параметрами в синтаксисе OpenAPI. */
  readonly path: string;
  /* Имя переносимой схемы тела; GET не имеет body. */
  readonly body?: Exclude<keyof HttpApiSchemas, HttpOperationName | "projectEvent">;
}
