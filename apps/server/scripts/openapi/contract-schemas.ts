import { fileURLToPath } from "node:url";
import { BATCH_OPERATIONS } from "@relay/core";
import { createCommandSchemas } from "../command-schema";
import { contractSchemaGenerator } from "../schema-generator";
import { generatorMessages } from "../generator.messages";
import {
  assertSchemaReferences,
  definitionReferenceName,
  rewriteSchemaReferences,
  schemaIdentifiers,
} from "./schema-references";
import type { ContractSchemaCatalog } from "./openapi.types";
import { successResponseReferences } from "./response-schemas";

/**
 * Строит нормализованный JSON Schema каталог Contracts без открытия проекта/SQLite.
 * Реальные операции и поля команд сверяются с текущим чистым каталогом Core.
 */
export function generateContractSchemas(): ContractSchemaCatalog {
  const generated = contractSchemaGenerator({
    path: fileURLToPath(
      new URL("../../../../packages/contracts/src/http/api-schema.types.ts", import.meta.url),
    ),
    tsconfig: fileURLToPath(
      new URL("../../../../packages/contracts/tsconfig.json", import.meta.url),
    ),
    type: "HttpApiSchemas",
    expose: "all",
    jsDoc: "extended",
    skipTypeCheck: true,
    additionalProperties: false,
  }).createSchema("HttpApiSchemas");
  const catalog = generated.definitions?.HttpApiSchemas;
  if (typeof catalog !== "object" || catalog.properties === undefined) {
    throw new Error(generatorMessages.missingCatalog);
  }
  const definitions = { ...generated.definitions, ...createCommandSchemas(BATCH_OPERATIONS) };
  const successes = successResponseReferences(catalog.properties, generated.definitions ?? {});
  const preferred = new Map<string, string>();
  for (const [suffix, entries] of [
    ["Response", catalog.properties],
    ["Success", successes],
  ] as const) {
    for (const [operation, shape] of Object.entries(entries).sort(([first], [second]) =>
      first.localeCompare(second),
    )) {
      if (typeof shape === "object" && shape.$ref?.startsWith("#/definitions/") === true) {
        const original = definitionReferenceName(shape.$ref);
        if (original.includes("def-") && !preferred.has(original)) {
          preferred.set(
            original,
            `Http${operation[0]?.toUpperCase()}${operation.slice(1)}${suffix}`,
          );
        }
      }
    }
  }
  const names = schemaIdentifiers(definitions, preferred);
  const normalized = Object.fromEntries(
    Object.entries(definitions).map(([name, schema]) => [
      names.get(name) ?? name,
      rewriteSchemaReferences(schema, names, "definitions"),
    ]),
  );
  const schema = { ...generated, definitions: normalized };
  assertSchemaReferences(schema);
  return {
    schema,
    operations: rewriteSchemaReferences(catalog.properties, names, "components"),
    successResponses: rewriteSchemaReferences(successes, names, "components"),
    names,
  };
}
