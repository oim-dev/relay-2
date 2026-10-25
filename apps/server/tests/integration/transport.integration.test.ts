import { describe, expect, spyOn, test } from "bun:test";
import { createConnection } from "node:net";
import { BatchService, KnowledgeService } from "@relay/core";
import { ProjectDatabase } from "@relay/storage";
import { HTTP_BODY_MAX_BYTES } from "../../src/http/json-body.pipe";
import { withServer } from "./fixture";

/**
 * Посылает wire path дословно: Fetch и inject нормализуют encoded dot segments ещё до сервера.
 * Connection:close и socket deadline гарантируют освобождение собственного соединения.
 */
function rawRequest(url: string, path: string): Promise<string> {
  const address = new URL(url);
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: address.hostname, port: Number(address.port) });
    let response = "";
    socket.setTimeout(3000, () => socket.destroy(new Error("Нет HTTP ответа")));
    socket.on("error", reject);
    socket.on("data", (chunk) => {
      response += chunk.toString();
    });
    socket.on("end", () => resolve(response));
    socket.on("connect", () =>
      socket.write(`GET ${path} HTTP/1.1\r\nHost: ${address.host}\r\nConnection: close\r\n\r\n`),
    );
  });
}

/**
 * Читает один SSE кадр, сохраняя остальные кадры того же chunk; deadline задаёт исходный fetch.
 */
function events(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): () => Promise<Record<string, unknown>> {
  let buffer = "";
  const decoder = new TextDecoder();
  return async () => {
    for (;;) {
      const boundary = buffer.indexOf("\n\n");
      if (boundary >= 0) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const data = frame.split("\n").find((line) => line.startsWith("data: "));
        const value: unknown = JSON.parse(data?.slice(6) ?? "null");
        if (value === null || typeof value !== "object" || Array.isArray(value)) {
          throw new Error("Некорректный SSE кадр");
        }
        // Проверена форма JSON объекта; значения отдельных полей проверяет сценарий.
        return value as Record<string, unknown>;
      }
      const chunk = await reader.read();
      if (chunk.done) {
        throw new Error("SSE завершился до ожидаемого события");
      }
      buffer += decoder.decode(chunk.value, { stream: true });
    }
  };
}

describe("Nest transport boundary", () => {
  test("явный controlHandler получает исходные bytes, а null сохраняет body для Nest pipe", async () => {
    await withServer(
      async ({ server, client, location }) => {
        const bytes = new Uint8Array([0, 255, 128, 1, 13, 10]);
        const echoed = await fetch(`${server.url}echo`, { method: "POST", body: bytes });
        expect(new Uint8Array(await echoed.arrayBuffer())).toEqual(bytes);
        const result = await client.command(location.projectId, {
          op: "document.create",
          input: { name: "После handler", body: "Точные байты" },
          actor: "Web",
          operationKey: "fallthrough",
        });
        expect(result.data.status).toBe("committed");
        expect(
          (await client.entities(location.projectId, { kind: "document" })).data.items[0],
        ).toMatchObject({ data: { body: "Точные байты" } });
      },
      {
        controlHandler: async (request) =>
          new URL(request.url).pathname === "/echo"
            ? new Response(await request.arrayBuffer())
            : null,
      },
    );
  });
  test("disconnect отменяет Web reader даже при ожидающем следующем chunk", async () => {
    const cancelled = Promise.withResolvers<void>();
    await withServer(
      async ({ server }) => {
        const response = await fetch(`${server.url}infinite.bin`, {
          signal: AbortSignal.timeout(3000),
        });
        const reader = response.body?.getReader();
        if (reader === undefined) {
          throw new Error("Нет streaming body");
        }
        expect(new TextDecoder().decode((await reader.read()).value)).toBe("first");
        await reader.cancel();
        await cancelled.promise;
      },
      {
        staticHandler: () =>
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(new TextEncoder().encode("first"));
              },
              cancel() {
                cancelled.resolve();
              },
            }),
          ),
      },
    );
  });

  test("encoded dot segments отвергаются до Fetch URL нормализации static handler", async () => {
    let invoked = false;
    await withServer(
      async ({ server }) => {
        const response = await rawRequest(server.url, "/public/%2e%2e/index.html");
        expect(response).toStartWith("HTTP/1.1 404");
        expect(response).toContain('"code":"NOT_FOUND"');
        expect(invoked).toBe(false);
      },
      {
        staticHandler: () => {
          invoked = true;
          return new Response("unexpected");
        },
      },
    );
  });
  test.each(["length", "stream"] as const)(
    "bodylimit %s возвращает JSON 413, сохраняя socket и отсутствие записи",
    async (mode) => {
      await withServer(async ({ server, location, client }) => {
        const bytes = new Uint8Array(HTTP_BODY_MAX_BYTES + 1).fill(32);
        const body =
          mode === "length"
            ? bytes
            : new ReadableStream<Uint8Array>({
                start(controller) {
                  controller.enqueue(bytes.subarray(0, HTTP_BODY_MAX_BYTES));
                  controller.enqueue(bytes.subarray(HTTP_BODY_MAX_BYTES));
                  controller.close();
                },
              });

        const response = await fetch(
          `${server.url}api/v2/projects/${location.projectId}/commands`,
          { method: "POST", headers: { "Content-Type": "application/json" }, body },
        );

        expect(response.status).toBe(413);
        expect(await response.json()).toMatchObject({
          ok: false,
          error: { code: "PAYLOAD_TOO_LARGE" },
        });
        expect((await client.entities(location.projectId, { kind: "document" })).data.total).toBe(
          0,
        );
      });
    },
  );

  test.each([
    {
      name: "malformed JSON",
      body: new TextEncoder().encode("{"),
      type: "application/json",
      status: 400,
      code: "INVALID_ARGUMENT",
    },
    {
      name: "UTF8 повреждение",
      body: new Uint8Array([123, 34, 120, 34, 58, 34, 255, 34, 125]),
      type: "application/json",
      status: 400,
      code: "INVALID_ARGUMENT",
    },
    {
      name: "JSON массив",
      body: new TextEncoder().encode("[]"),
      type: "application/json",
      status: 400,
      code: "INVALID_ARGUMENT",
    },
    {
      name: "неверный media type",
      body: new TextEncoder().encode("{}"),
      type: "text/plain",
      status: 415,
      code: "UNSUPPORTED_MEDIA_TYPE",
    },
  ])("$name не попадает в Core", async ({ body, type, status, code }) => {
    await withServer(async ({ server, location, client }) => {
      const response = await fetch(`${server.url}api/v2/projects/${location.projectId}/commands`, {
        method: "POST",
        headers: { "Content-Type": type },
        body,
      });
      expect(response.status).toBe(status);
      expect(await response.json()).toMatchObject({ ok: false, error: { code } });
      expect((await client.entities(location.projectId, { kind: "document" })).data.total).toBe(0);
    });
  });

  test("Host/Origin, preflight и static HEAD проходят реальный guard и сохраняют metadata", async () => {
    await withServer(
      async ({ server }) => {
        const foreignHost = await fetch(`${server.url}api/v2/context`, {
          headers: { Host: "evil.example" },
        });
        const foreignOrigin = await fetch(`${server.url}api/v2/context`, {
          headers: { Origin: "https://evil.example" },
        });
        const crossSite = await fetch(`${server.url}api/v2/context`, {
          headers: { "Sec-Fetch-Site": "cross-site" },
        });
        const preflight = await fetch(`${server.url}api/v2/context`, {
          method: "OPTIONS",
          headers: { Origin: "http://127.0.0.1:5173" },
        });
        const head = await fetch(`${server.url}asset.js`, { method: "HEAD" });
        const missing = await fetch(`${server.url}api/v2/missing`);

        expect(foreignHost.status).toBe(403);
        expect(await foreignHost.json()).toMatchObject({ error: { code: "HOST_FORBIDDEN" } });
        expect(foreignOrigin.status).toBe(403);
        expect(await foreignOrigin.json()).toMatchObject({ error: { code: "ORIGIN_FORBIDDEN" } });
        expect(crossSite.status).toBe(403);
        expect(preflight.status).toBe(204);
        expect(preflight.headers.get("access-control-allow-origin")).toBe("http://127.0.0.1:5173");
        expect(head.status).toBe(200);
        expect(await head.text()).toBe("");
        expect(head.headers.get("content-length")).toBe("3");
        expect(head.headers.get("etag")).toBe('"asset"');
        expect(head.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
        expect(missing.status).toBe(404);
        expect(await missing.json()).toMatchObject({ error: { code: "NOT_FOUND" } });
      },
      {
        allowedOrigins: ["http://127.0.0.1:5173"],
        staticHandler: (request) =>
          new Response(request.method === "HEAD" ? null : "abc", {
            headers: {
              "Content-Type": "application/javascript",
              "Content-Length": "3",
              ETag: '"asset"',
              "Cache-Control": "public, max-age=31536000, immutable",
            },
          }),
      },
    );
  });

  test("SSE замечает внешний commit узким generation read, reconnect и close освобождают streams", async () => {
    await withServer(async ({ server, client, database, location }) => {
      const first = await fetch(client.eventsUrl(location.projectId), {
        signal: AbortSignal.timeout(4000),
      });
      const reader = first.body?.getReader();
      if (reader === undefined) {
        throw new Error("Нет SSE body");
      }
      const next = events(reader);
      const connected = await next();
      const list = spyOn(ProjectDatabase.prototype, "list");
      const graph = spyOn(ProjectDatabase.prototype, "listTaskGraph");
      try {
        await database((db) =>
          new KnowledgeService(db).create(
            "document",
            { name: "CLI", body: "Внешняя запись" },
            "CLI",
          ),
        );
        let event = await next();
        while (event.type === "heartbeat") {
          event = await next();
        }
        expect(event).toMatchObject({ type: "changed", projectId: location.projectId });
        expect(event.generation).toBeGreaterThan(Number(connected.generation));
        expect(list).not.toHaveBeenCalled();
        expect(graph).not.toHaveBeenCalled();
        await reader.cancel();
        const reconnect = await fetch(client.eventsUrl(location.projectId), {
          signal: AbortSignal.timeout(4000),
        });
        const second = reconnect.body?.getReader();
        if (second === undefined) {
          throw new Error("Нет reconnect body");
        }
        expect(await events(second)()).toMatchObject({
          type: "connected",
          generation: event.generation,
        });
        await server.close();
        expect((await second.read()).done).toBe(true);
        await second.cancel();
      } finally {
        list.mockRestore();
        graph.mockRestore();
        await reader.cancel();
      }
    });
  });

  test("graceful close ожидает принятый Core writer и отвергает новые handlers", async () => {
    const entered = Promise.withResolvers<void>();
    const released = Promise.withResolvers<void>();
    const original = BatchService.prototype.execute;
    await withServer(async ({ server, client, location, database }) => {
      const execute = spyOn(BatchService.prototype, "execute").mockImplementation(async function (
        this: BatchService,
        input,
        options,
      ) {
        entered.resolve();
        await released.promise;
        return original.call(this, input, options);
      });
      try {
        const writing = client.command(location.projectId, {
          op: "document.create",
          input: { name: "Сохранится", body: "После shutdown" },
          actor: "Web",
          operationKey: "drain",
        });
        await entered.promise;
        let closed = false;
        const closing = server.close().then(() => {
          closed = true;
        });
        const rejected = await server.app.inject({
          method: "GET",
          url: "/api/v2/context",
          headers: { host: new URL(server.url).host },
        });
        expect(rejected.statusCode).toBe(503);
        expect(rejected.json()).toMatchObject({ error: { code: "SERVER_CLOSING" } });
        expect(closed).toBe(false);
        released.resolve();
        expect((await writing).data.status).toBe("committed");
        await closing;
        expect(await database((db) => new KnowledgeService(db).list("document"))).toMatchObject([
          { data: { body: "После shutdown" } },
        ]);
      } finally {
        released.resolve();
        execute.mockRestore();
      }
    });
  });
});
