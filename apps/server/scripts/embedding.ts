import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { collectWebFiles } from "../src/modules/assets/catalog";
import type { WebEmbedding } from "./embedding.types";

/**
 * Генерирует прямые file imports каждого готового Vite файла, без frontend трансформации Bun.
 * Публичный URL/MIME не зависят от внутреннего имени embedded BunFile.
 */
export function createWebEmbedding(directory: string): WebEmbedding {
  const files = collectWebFiles(directory);
  const imports = files
    .map(
      (file, index) =>
        `import asset${index} from ${JSON.stringify(file.source)} with { type: "file" };`,
    )
    .join("\n");
  const entries = files.map(
    ({ url, source: _source, bytes: _bytes, ...metadata }, index) =>
      `[${JSON.stringify(url)}, { ...${JSON.stringify(metadata)}, body: Bun.file(asset${index}) }]`,
  );
  const contents = `${imports}\nexport function loadWebAssets() { return new Map([${entries.join(",\n")}]); }\n`;
  const importer = fileURLToPath(
    new URL("../src/modules/assets/static-handler.ts", import.meta.url),
  );
  let used = false;
  return {
    urls: files.map((file) => file.url),
    /**
     * Подтверждает, что текущая сборка действительно заменила source loader.
     */
    used: (): boolean => used,
    plugin: {
      name: "relay-web-files",
      /**
       * Заменяет один source loader прямым virtual module; asset aliases намеренно отсутствуют.
       */
      setup(build): void {
        build.onResolve({ filter: /^\.\/load-assets$/ }, (args) => {
          if (resolve(args.importer) !== importer) {
            return undefined;
          }
          used = true;
          return { path: "relay:embedded-web", namespace: "relay-web-files" };
        });
        build.onLoad({ filter: /.*/, namespace: "relay-web-files" }, () => ({
          contents,
          loader: "ts",
          resolveDir: resolve(directory),
        }));
      },
    },
  };
}
