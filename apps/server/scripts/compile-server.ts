import { mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { RelayError } from "@relay/contracts";
import { createWebEmbedding } from "./embedding";
import { assetMessages } from "../src/modules/assets/assets.messages";
import { OPTIONAL_NEST_EXTENSIONS } from "./compile-options";

/**
 * Единый production/test compile путь полного Server с guardian и всеми готовыми Web файлами.
 * Явный tsconfig сохраняет Nest legacy decorators независимо от cwd сборщика; DTO metadata emit не нужен.
 * При отказе не оставляет прежний/частичный outfile как результат текущей сборки.
 */
export async function compileServer(
  webDirectory: string,
  outfile: string,
): Promise<readonly string[]> {
  const root = fileURLToPath(new URL("../", import.meta.url));
  try {
    const embedding = createWebEmbedding(webDirectory);
    await mkdir(dirname(outfile), { recursive: true });
    const result = await Bun.build({
      entrypoints: [join(root, "src/main.ts")],
      target: "bun",
      format: "esm",
      tsconfig: join(root, "tsconfig.json"),
      external: OPTIONAL_NEST_EXTENSIONS,
      compile: {
        outfile,
        autoloadDotenv: false,
        autoloadBunfig: false,
        autoloadPackageJson: false,
        autoloadTsconfig: false,
      },
      plugins: [embedding.plugin],
    });
    if (!result.success) {
      throw new AggregateError(result.logs, assetMessages.build);
    }
    if (!embedding.used()) {
      throw new RelayError("WEB_EMBEDDING_UNUSED", assetMessages.unused);
    }
    return embedding.urls;
  } catch (error) {
    await rm(outfile, { force: true });
    throw error;
  }
}
