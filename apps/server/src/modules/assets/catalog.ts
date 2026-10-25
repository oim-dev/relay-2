import { readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, relative, resolve, sep } from "node:path";
import { RelayError } from "@relay/contracts";
import { assetMessages } from "./assets.messages";
import type { WebAssetFile } from "./assets.types";

/**
 * Один раз перечисляет ВСЕ обычные файлы готового Vite output, включая lazy/worker/public assets.
 * Только source/build путь читает filesystem; compiled loader содержит прямые file imports.
 */
export function collectWebFiles(directory: string): readonly WebAssetFile[] {
  const root = resolve(directory);
  if (!statSync(join(root, "index.html"), { throwIfNoEntry: false })?.isFile()) {
    throw new RelayError("WEB_BUILD_MISSING", assetMessages.missing, 3, { path: root });
  }
  const files: WebAssetFile[] = [];
  for (const entry of readdirSync(root, { recursive: true, withFileTypes: true })) {
    const source = join(entry.parentPath, entry.name);
    if (entry.isSymbolicLink()) {
      throw new RelayError("WEB_ASSET_SYMLINK", assetMessages.symlink, 2, { path: source });
    }
    if (!entry.isFile()) {
      continue;
    }
    const url = "/" + relative(root, source).split(sep).map(encodeURIComponent).join("/");
    const bytes = new Uint8Array(readFileSync(source));
    files.push({
      url,
      source,
      bytes,
      size: bytes.byteLength,
      contentType: Bun.file(source).type || "application/octet-stream",
      etag: `"${new Bun.CryptoHasher("sha256").update(bytes).digest("hex")}"`,
      immutable:
        extname(source).toLowerCase() !== ".html" &&
        /^\/assets\/(?:[^/]+\/)*[^/]+-[A-Za-z0-9_-]{8,}\.[^/]+$/.test(url),
    });
  }
  return files.sort((left, right) => left.url.localeCompare(right.url));
}
