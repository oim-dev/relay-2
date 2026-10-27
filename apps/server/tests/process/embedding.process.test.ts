import { describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { initializeProject, nativeExecutableName } from "@relay/project-runtime";
import { compileServer } from "../../scripts/compile-server";
import { startChild, stopChild } from "./process-fixture";

const files = [
  {
    path: "index.html",
    text: '<html><script type="module" src="/assets/main-Abc123xy.js"></script></html>',
    mime: "text/html",
  },
  {
    path: "assets/main-Abc123xy.js",
    text: 'import("./lazy-Lazy1234.js"); new Worker(new URL("./worker-Work1234.js", import.meta.url));',
    mime: "javascript",
  },
  { path: "assets/lazy-Lazy1234.js", text: "export const lazy = 'готово';", mime: "javascript" },
  { path: "assets/worker-Work1234.js", text: "postMessage('worker');", mime: "javascript" },
  { path: "assets/style-Style123.css", text: "body { color: red; }", mime: "text/css" },
  { path: "assets/a/font-Font1234.woff2", text: "font-bytes", mime: "font/woff2" },
  { path: "assets/a/same-Same1234.js", text: "export default 1;", mime: "javascript" },
  { path: "assets/b/same-Same1234.js", text: "export default 2;", mime: "javascript" },
  { path: "public/файл %#.svg", text: "<svg/>", mime: "image/svg+xml" },
  {
    path: "unreferenced.bin",
    text: "\u0000\u0001never-imported",
    mime: "application/octet-stream",
  },
];

describe("Полнота standalone embedding", () => {
  test("полный Nest binary после удаления build inputs сохраняет lazy/worker/fonts/public и одинаковые basenames", async () => {
    const parent = resolve(
      import.meta.dir,
      "../../../../.artifacts",
      new Date().toISOString().slice(0, 10),
      "server-web/nest-server/embedding",
    );
    await mkdir(parent, { recursive: true });
    const directory = await mkdtemp(join(parent, "files-"));
    const input = join(directory, "vite-output");
    const output = join(directory, "output", nativeExecutableName("relay-server"));
    try {
      for (const file of files) {
        await mkdir(dirname(join(input, file.path)), { recursive: true });
        await writeFile(join(input, file.path), file.text);
      }
      const urls = await compileServer(input, output);
      expect(urls).toHaveLength(files.length);
      const detached = join(directory, "detached");
      await mkdir(detached);
      const binary = join(detached, nativeExecutableName("relay-server"));
      await rename(output, binary);
      await chmod(binary, 0o755);
      await rm(input, { recursive: true });
      await rm(join(directory, "output"), { recursive: true });
      const runtime = { cwd: join(detached, "project"), home: join(detached, "home") };
      initializeProject({ ...runtime, name: "Embedded Nest" });
      const child = await startChild(binary, runtime.cwd, ["--port", "0"], {
        HOME: detached,
        RELAY_HOME: runtime.home,
        PATH: "/nonexistent",
      });
      try {
        for (const file of files) {
          const url = file.path.split("/").map(encodeURIComponent).join("/");
          const response = await fetch(new URL(url, child.ready.url));
          expect(response.status).toBe(200);
          expect(new Uint8Array(await response.arrayBuffer())).toEqual(
            new TextEncoder().encode(file.text),
          );
          expect(response.headers.get("content-type")).toContain(file.mime);
        }
      } finally {
        await stopChild(child);
      }
      expect(child.process.exitCode).toBe(0);
      expect(await child.stderr).toBe("");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 30000);
});
