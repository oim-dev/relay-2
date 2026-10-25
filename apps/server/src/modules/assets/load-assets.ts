import { fileURLToPath } from "node:url";
import { collectWebFiles } from "./catalog";
import type { WebAsset } from "./assets.types";

/**
 * Source загрузчик готового dist: фиксирует bytes/ETag одним snapshot.
 * Bun plugin полностью заменяет этот модуль в standalone executable.
 */
export function loadWebAssets(): ReadonlyMap<string, WebAsset> {
  const directory = fileURLToPath(new URL("../../../../web/dist/", import.meta.url));
  return new Map(
    collectWebFiles(directory).map(({ url, bytes, source: _source, ...metadata }) => [
      url,
      { ...metadata, body: new Blob([bytes]) },
    ]),
  );
}
