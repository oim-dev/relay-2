import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { compileServer } from "./compile-server";

/**
 * Компилирует Nest/Fastify Server с guardian и готовым Vite output в один executable.
 * Vite запускается отдельно Node/Turbo; Bun только сохраняет готовые HTML/JS/CSS/assets bytes.
 */
async function buildServer(): Promise<void> {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const outfile = join(
    root,
    "dist",
    process.platform === "win32" ? "relay-server.exe" : "relay-server",
  );
  const assets = await compileServer(
    fileURLToPath(new URL("../../web/dist/", import.meta.url)),
    outfile,
  );
  console.log(JSON.stringify({ binary: outfile, webAssets: assets.length }));
}

await buildServer();
