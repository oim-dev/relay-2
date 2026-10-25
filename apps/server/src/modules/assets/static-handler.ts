import type { ServerStaticHandler } from "../../server.types";
import type { WebAsset } from "./assets.types";
import { loadWebAssets } from "./load-assets";

/**
 * Канонизирует ровно один уровень URL escaping; separators/dot/NUL не адресуют другой файл.
 */
export function canonicalAssetPath(path: string): string | null {
  try {
    const segments = path.split("/").map(decodeURIComponent);
    return segments.some((part) => part === "." || part === ".." || /[\\/\0]/.test(part))
      ? null
      : segments.map(encodeURIComponent).join("/");
  } catch {
    return null;
  }
}

/**
 * Разрешает SPA только для согласованных маршрутов Web и настоящей HTML navigation.
 */
function navigation(request: Request, path: string): boolean {
  const destination = request.headers.get("sec-fetch-dest");
  if (destination !== null && destination !== "document" && destination !== "iframe") {
    return false;
  }
  const html = request.headers
    .get("accept")
    ?.split(",")
    .some((entry) => {
      const [type, ...parameters] = entry.trim().toLowerCase().split(";");
      return (
        type === "text/html" &&
        !parameters.some((parameter) => /^\s*q=0(?:\.0*)?\s*$/.test(parameter))
      );
    });
  return (
    Boolean(html) &&
    /^\/projects\/[^/]+(?:\/(?:documents|board|plans|releases|history)|\/(?:knowledge|entities|tasks|plans|releases)\/[^/]+|\/history\/sessions\/[^/]+)?\/?$/.test(
      path,
    )
  );
}

/**
 * Подготавливает byte-exact GET/HEAD handler готового каталога, без последующего filesystem I/O.
 * API, missing assets и Worker запросы никогда не превращаются в SPA shell.
 */
export function createStaticHandler(assets: ReadonlyMap<string, WebAsset>): ServerStaticHandler {
  return (request) => {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return null;
    }
    const path = canonicalAssetPath(new URL(request.url).pathname);
    if (path === null || path === "/api" || path.startsWith("/api/")) {
      return null;
    }
    const direct = assets.get(path === "/" ? "/index.html" : path);
    const fallback = direct === undefined && navigation(request, path);
    const asset = direct ?? (fallback ? assets.get("/index.html") : undefined);
    if (asset === undefined) {
      return null;
    }
    const headers = new Headers({
      "Content-Type": asset.contentType,
      "Content-Length": String(asset.size),
      ETag: asset.etag,
      "Cache-Control": asset.immutable ? "public, max-age=31536000, immutable" : "no-cache",
      "X-Content-Type-Options": "nosniff",
    });
    if (fallback) {
      headers.set("Vary", "Accept, Sec-Fetch-Dest");
    }
    const unchanged = request.headers
      .get("if-none-match")
      ?.split(",")
      .some((value) => value.trim() === "*" || value.trim().replace(/^W\//, "") === asset.etag);
    if (unchanged) {
      headers.delete("Content-Length");
      return new Response(null, { status: 304, headers });
    }
    return new Response(request.method === "HEAD" ? null : asset.body, { headers });
  };
}

/**
 * Подключает source snapshot либо compiled embedded-карту, не открывая проекты/БД.
 */
export function createWebHandler(): ServerStaticHandler {
  return createStaticHandler(loadWebAssets());
}
