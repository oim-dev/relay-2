import { describe, expect, test } from "bun:test";
import { createStaticHandler } from "./static-handler";

const handler = createStaticHandler(
  new Map([
    [
      "/index.html",
      {
        body: new Blob(["<html>Web</html>"]),
        contentType: "text/html;charset=utf-8",
        size: 16,
        etag: '"html"',
        immutable: false,
      },
    ],
    [
      "/assets/chunk-Abc123xy.js",
      {
        body: new Blob(["abc"]),
        contentType: "application/javascript;charset=utf-8",
        size: 3,
        etag: '"js"',
        immutable: true,
      },
    ],
    [
      "/public/%D1%84%D0%B0%D0%B9%D0%BB%20%25%23.svg",
      {
        body: new Blob(["svg"]),
        contentType: "image/svg+xml",
        size: 3,
        etag: '"svg"',
        immutable: false,
      },
    ],
  ]),
);

describe("Byte-static и ограниченный SPA fallback", () => {
  test("HEAD сохраняет длину, MIME и validators; weak If-None-Match возвращает 304 без тела", async () => {
    const head = await handler(
      new Request("http://localhost/assets/chunk-Abc123xy.js", { method: "HEAD" }),
    );
    expect(head?.headers.get("content-length")).toBe("3");
    expect(head?.headers.get("content-type")).toBe("application/javascript;charset=utf-8");
    expect(head?.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(await head?.text()).toBe("");
    const cached = await handler(
      new Request("http://localhost/assets/chunk-Abc123xy.js", {
        headers: { "If-None-Match": '"other", W/"js"' },
      }),
    );
    expect(cached?.status).toBe(304);
    expect(cached?.headers.get("content-length")).toBeNull();
    expect(await cached?.text()).toBe("");
  });

  test("encoded public filename сохраняется, query не меняет bytes", async () => {
    const response = await handler(
      new Request("http://localhost/public/%D1%84%D0%B0%D0%B9%D0%BB%20%25%23.svg?v=1"),
    );
    expect(await response?.text()).toBe("svg");
    expect(response?.headers.get("cache-control")).toBe("no-cache");
  });

  test.each([
    "/api",
    "/api/v2/missing",
    "/assets/missing.js",
    "/missing",
    "/projects/id/missing",
    "/public/%2findex.html",
    "/public/%",
    "/public/%00",
  ])("%s не превращается в HTML", async (path) => {
    expect(
      await handler(new Request(`http://localhost${path}`, { headers: { Accept: "text/html" } })),
    ).toBeNull();
  });

  test.each([
    "/projects/id",
    "/projects/id/documents",
    "/projects/id/tasks/TASK-1",
    "/projects/id/history/sessions/SESSION-1",
  ])("%s отдаёт shell только для navigation", async (path) => {
    const response = await handler(
      new Request(`http://localhost${path}`, {
        headers: { Accept: "text/html", "Sec-Fetch-Dest": "document" },
      }),
    );
    expect(await response?.text()).toBe("<html>Web</html>");
    expect(response?.headers.get("cache-control")).toBe("no-cache");
    expect(response?.headers.get("vary")).toBe("Accept, Sec-Fetch-Dest");
    expect(
      await handler(
        new Request(`http://localhost${path}`, { headers: { Accept: "application/json" } }),
      ),
    ).toBeNull();
    expect(
      await handler(
        new Request(`http://localhost${path}`, {
          headers: { Accept: "text/html", "Sec-Fetch-Dest": "worker" },
        }),
      ),
    ).toBeNull();
  });
});
