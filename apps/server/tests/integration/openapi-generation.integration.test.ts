import { describe, expect, test } from "bun:test";
import Ajv from "ajv";
import openapi from "../../openapi.json";
import generatedSchemas from "../../src/http/generated-schemas.json";
import { generateContractSchemas } from "../../scripts/openapi/contract-schemas";
import { assembleOpenApiDocument } from "../../scripts/openapi/document";
import { createSwaggerDocument } from "../../scripts/openapi/nest-document";
import { assertSchemaReferences } from "../../scripts/openapi/schema-references";
import { withServer } from "./fixture";

const catalog = generateContractSchemas();
const source = createSwaggerDocument();
const generated = assembleOpenApiDocument(source, catalog);
const ajv = new Ajv({ strict: false });
ajv.addSchema({ components: generated.components }, "openapi");
ajv.addSchema(generatedSchemas, "raw-http");

describe("Воспроизводимая генерация OpenAPI реальных Nest controllers", () => {
  test("outputs совпадают с module graph и Contracts без создания приложения или пользовательской БД", () => {
    expect<unknown>(generated).toEqual(openapi);
    expect<unknown>(catalog.schema).toEqual(generatedSchemas);
    expect(Object.keys(generated.paths).sort()).toEqual(Object.keys(source.paths).sort());
    expect(() => assertSchemaReferences(generated)).not.toThrow();
    for (const name of Object.keys(generated.components.schemas)) {
      expect(name).toMatch(/^[A-Za-z][A-Za-z0-9_]*$/);
      expect(name).not.toContain("def_interface");
      expect(name).not.toContain("def_alias");
    }
    expect(JSON.stringify(generated)).not.toContain("#/components/schemas/HttpResponse%");
  });

  test("неизвестная либо пропавшая операция и несовпадающий путь останавливают генерацию", () => {
    const missing = structuredClone(source);
    delete missing.paths["/api/v2/context"];
    expect(() => assembleOpenApiDocument(missing, catalog)).toThrow("не реализована контроллером");

    const unknown = structuredClone(source);
    unknown.paths["/api/v2/future"] = { get: { operationId: "future", responses: {} } };
    expect(() => assembleOpenApiDocument(unknown, catalog)).toThrow("Неизвестный HTTP-сценарий");

    const wrong = structuredClone(source);
    wrong.paths["/api/v2/wrong"] = { get: { operationId: "context", responses: {} } };
    delete wrong.paths["/api/v2/context"];
    expect(() => assembleOpenApiDocument(wrong, catalog)).toThrow("маршрут не совпадает");
  });

  test("response контекста имеет собственный DTO, а не потерянную ссылку на implementation", () => {
    const response = generated.paths["/api/v2/context"]?.get?.responses["200"];
    if (response === undefined || !("content" in response)) {
      throw new Error("Нет JSON response контекста");
    }
    const schema = response.content?.["application/json"]?.schema;
    if (schema === undefined || !("$ref" in schema)) {
      throw new Error("Нет именованного response контекста");
    }
    const validate = ajv.compile({ $ref: `openapi${schema.$ref}` });

    expect(
      validate({
        ok: true,
        data: { version: "test", mode: "project", projects: [], actor: "Автор" },
      }),
    ).toBe(true);
    expect(validate({ ok: true, data: { title: "Реализация", kind: "implementation" } })).toBe(
      false,
    );
    expect(
      validate({
        ok: true,
        data: { version: "test", mode: "other", projects: [], actor: "Автор" },
      }),
    ).toBe(false);
    expect(validate({ ok: false, error: { code: "INVALID_ARGUMENT", message: "Отказ" } })).toBe(
      false,
    );
  });

  test("реальный HTTP 400 не проходит schema 200; отдельная ошибка и raw Git envelope сохраняются", async () => {
    const commandResponse =
      generated.paths["/api/v2/projects/{projectId}/commands"]?.post?.responses["200"];
    const successSchema =
      commandResponse !== undefined && "content" in commandResponse
        ? commandResponse.content?.["application/json"]?.schema
        : undefined;
    if (successSchema === undefined || !("$ref" in successSchema)) {
      throw new Error("Нет schema успешной команды");
    }
    const validateSuccess = ajv.compile({ $ref: `openapi${successSchema.$ref}` });
    const validateError = ajv.compile({
      $ref: "openapi#/components/responses/Error/content/application~1json/schema",
    });
    const validateRawGitEnvelope = ajv.compile({
      $ref: "raw-http#/definitions/HttpApiSchemas/properties/gitSyncStatus",
    });

    await withServer(async ({ server, location }) => {
      const request = { op: "task.create", actor: "Ревью", operationKey: "status-valid" };
      const headers = { host: new URL(server.url).host, "content-type": "application/json" };
      const success = await server.app.inject({
        method: "POST",
        url: `/api/v2/projects/${location.projectId}/commands`,
        headers,
        payload: JSON.stringify(request),
      });
      const failure = await server.app.inject({
        method: "POST",
        url: `/api/v2/projects/${location.projectId}/commands`,
        headers,
        payload: JSON.stringify({
          ...request,
          operationKey: "status-invalid",
          input: { title: 3 },
        }),
      });
      const successBody: unknown = success.json();
      const errorBody: unknown = failure.json();

      expect(success.statusCode).toBe(200);
      expect(successBody).toMatchObject({ ok: true, data: { status: "committed" } });
      expect(validateSuccess(successBody), JSON.stringify(validateSuccess.errors)).toBe(true);
      expect(failure.statusCode).toBe(400);
      expect(errorBody).toMatchObject({ ok: false, error: { code: "INVALID_ARGUMENT" } });
      expect(validateSuccess(errorBody)).toBe(false);
      expect(validateError(errorBody), JSON.stringify(validateError.errors)).toBe(true);
      expect(validateError(successBody)).toBe(false);
      expect(validateRawGitEnvelope(errorBody), JSON.stringify(validateRawGitEnvelope.errors)).toBe(
        true,
      );

      for (const item of Object.values(generated.paths)) {
        for (const operation of [item.get, item.post]) {
          if (
            operation?.operationId === undefined ||
            catalog.successResponses[operation.operationId] === undefined
          ) {
            continue;
          }
          const response = operation.responses["200"];
          const schema =
            response !== undefined && "content" in response
              ? response.content?.["application/json"]?.schema
              : undefined;
          if (schema === undefined || !("$ref" in schema)) {
            throw new Error(`Нет schema 200: ${operation.operationId}`);
          }
          expect(
            ajv.compile({ $ref: `openapi${schema.$ref}` })(errorBody),
            operation.operationId,
          ).toBe(false);
        }
      }
    });
  });

  test("receipt сохраняет обязательный query; single/batch используют полные discriminated schemas", () => {
    expect(
      generated.paths["/api/v2/projects/{projectId}/receipts"]?.get?.parameters,
    ).toContainEqual(
      expect.objectContaining({
        name: "operationKey",
        in: "query",
        required: true,
        schema: expect.objectContaining({ type: "string" }),
      }),
    );
    expect(generated.components.schemas.HttpCommandRequest).toMatchObject({
      discriminator: { propertyName: "op" },
    });
    expect(generated.components.schemas.HttpBatchCommand).toMatchObject({
      discriminator: { propertyName: "op" },
    });
    expect(
      generated.paths["/api/v2/projects/{projectId}/commands"]?.post?.requestBody,
    ).toMatchObject({
      content: {
        "application/json": { schema: { $ref: "#/components/schemas/HttpCommandRequest" } },
      },
    });
    expect(generated.paths["/api/v2/projects/{projectId}/batch"]?.post?.requestBody).toMatchObject({
      content: {
        "application/json": { schema: { $ref: "#/components/schemas/HttpBatchRequest" } },
      },
    });
  });
});
