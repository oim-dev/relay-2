import { writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { OpenAPIObject } from "@nestjs/swagger";
import { format, resolveConfig } from "prettier";
import { generateContractSchemas } from "./openapi/contract-schemas";
import { assembleOpenApiDocument } from "./openapi/document";

/**
 * Записывает воспроизводимый JSON в существующий либо новый каталог output.
 */
async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(
    path,
    await format(JSON.stringify(value), { ...(await resolveConfig(path)), filepath: path }),
  );
}

/**
 * Единственный вход генерации Server: сначала переносимые схемы для adapters,
 * затем настоящий Swagger document без проекта/БД. SDK имеет отдельный entry,
 * поэтому здесь нет циклической зависимости server-build → SDK → server-build.
 * Source factory вызывается после записи schemas: её controllers могут импортировать adapters.
 */
export async function generateApi(source: () => Promise<OpenAPIObject>): Promise<void> {
  const catalog = generateContractSchemas();
  await writeJson(
    fileURLToPath(new URL("../src/http/generated-schemas.json", import.meta.url)),
    catalog.schema,
  );
  const document = assembleOpenApiDocument(await source(), catalog);
  await writeJson(fileURLToPath(new URL("../openapi.json", import.meta.url)), document);
}

if (import.meta.main) {
  await generateApi(async () => (await import("./openapi/nest-document")).createSwaggerDocument());
}
