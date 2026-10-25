import { describe, expect, test } from "bun:test";
import {
  assertSchemaReferences,
  rewriteSchemaReferences,
  schemaIdentifier,
  schemaIdentifiers,
} from "./schema-references";

describe("Имена компонентов и JSON Pointer OpenAPI", () => {
  test("percent-encoded generic ссылается на свой простой компонент без потери различий типов", () => {
    const names = schemaIdentifiers({
      'HttpResponse<KnowledgeRecord<"implementation">>': {},
      "HttpResponse<ServerContext>": {},
    });
    const source = {
      oneOf: [
        { $ref: "#/definitions/HttpResponse%3CKnowledgeRecord%3C%22implementation%22%3E%3E" },
        { $ref: "#/definitions/HttpResponse%3CServerContext%3E" },
      ],
    };

    const normalized = rewriteSchemaReferences(source, names, "components");

    expect(normalized.oneOf[0]?.$ref).toBe(
      `#/components/schemas/${names.get('HttpResponse<KnowledgeRecord<"implementation">>')}`,
    );
    expect(normalized.oneOf[1]?.$ref).toBe(
      `#/components/schemas/${names.get("HttpResponse<ServerContext>")}`,
    );
    expect(normalized.oneOf[0]?.$ref).not.toBe(normalized.oneOf[1]?.$ref);
    expect(source.oneOf[1]?.$ref).toBe("#/definitions/HttpResponse%3CServerContext%3E");
    for (const name of names.values()) {
      expect(name).toMatch(/^[A-Za-z][A-Za-z0-9_]*$/);
    }
  });

  test("имена, совпадающие после удаления знаков, сохраняют разные стабильные identifiers", () => {
    expect(schemaIdentifier("A<B>")).not.toBe(schemaIdentifier("A[B]"));
    expect(schemaIdentifier("A<B>")).toBe(schemaIdentifier("A<B>"));
    expect(schemaIdentifier("HttpBatchRequest")).toBe("HttpBatchRequest");
  });

  test("RFC6901 escaping, suffix и общие объекты схем переписываются ровно один раз", () => {
    const shared = { $ref: "#/definitions/A~1B~0C/properties/part~1name" };
    const names = schemaIdentifiers({ "A/B~C": {} });
    const result = rewriteSchemaReferences({ oneOf: [shared, shared] }, names, "components");

    expect(result.oneOf[0]?.$ref).toBe(
      `#/components/schemas/${names.get("A/B~C")}/properties/part~1name`,
    );
    expect(result.oneOf[1]).toEqual(result.oneOf[0]);
  });

  test("batch-маркеры в examples не считаются schema refs, а одноимённое свойство схемы проверяется", () => {
    const result = rewriteSchemaReferences(
      {
        properties: { examples: { $ref: "#/definitions/Target" } },
        examples: [{ $ref: "previous" }],
      },
      schemaIdentifiers({ Target: {} }),
      "components",
    );

    expect(result.properties.examples.$ref).toBe("#/components/schemas/Target");
    expect(result.examples).toEqual([{ $ref: "previous" }]);
  });

  test("висячие и внешние ссылки останавливают генерацию; pointer может адресовать массив", () => {
    expect(() =>
      assertSchemaReferences({ definitions: { A: {} }, $ref: "#/definitions/B" }),
    ).toThrow("Неразрешимая ссылка");
    expect(() => assertSchemaReferences({ $ref: "https://example.org/schema" })).toThrow(
      "локальная ссылка",
    );
    expect(() => assertSchemaReferences({ oneOf: [{}], $ref: "#/oneOf/0" })).not.toThrow();
  });
});
