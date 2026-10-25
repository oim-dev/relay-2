import { describe, expect, test } from "bun:test";
import { withServer } from "./fixture";

const defaultHosts = ["127.0.0.1:80", "localhost:80", "[::1]:80"] as const;
const accepted = [
  { name: "IPv4 без явного порта", host: "127.0.0.1", origin: "http://127.0.0.1" },
  { name: "IPv4 с явным Host :80", host: "127.0.0.1:80", origin: "http://127.0.0.1" },
  { name: "IPv4 с явным Origin :80", host: "127.0.0.1", origin: "http://127.0.0.1:80" },
  { name: "localhost", host: "localhost", origin: "http://localhost:80" },
  { name: "localhost :80", host: "localhost:80", origin: "http://localhost" },
  { name: "IPv6", host: "[::1]", origin: "http://[::1]:80" },
  { name: "IPv6 :80", host: "[::1]:80", origin: "http://[::1]" },
  { name: "точный dev origin", host: "127.0.0.1", origin: "http://127.0.0.1:5173" },
] as const;
const forbiddenHosts = [
  "127.0.0.1:81",
  "localhost:81",
  "example.test",
  "127.1",
  "0x7f000001",
  "user@127.0.0.1",
  "127.0.0.1/",
  "127.0.0.1/path",
  "127.0.0.1?x=1",
  "127.0.0.1#fragment",
  "127.0.0.1:0080",
  "127.0.0.1:65536",
  "127.0.0.1:invalid",
  "127.0.0.1:",
] as const;
const forbiddenOrigins = [
  "http://example.test",
  "http://127.0.0.1:81",
  "https://127.0.0.1",
  "http://user@127.0.0.1",
  "http://127.0.0.1/",
  "http://127.0.0.1/path",
  "http://127.0.0.1?x=1",
  "http://127.0.0.1#fragment",
  "http://127.0.0.1:0080",
  "null",
  "http://127.0.0.1:5174",
  "http://127.0.0.1:5173/",
  "http://localhost:5173",
] as const;

describe("Host/Origin стандартного HTTP порта", () => {
  test("allowlist без :80 допускает эквивалентный Host с явным стандартным портом", async () => {
    await withServer(
      async ({ server }) => {
        const response = await server.app.inject({
          method: "GET",
          url: "/api/v2/context",
          headers: { host: "127.0.0.1:80", origin: "http://127.0.0.1:80" },
        });

        expect(response.statusCode).toBe(200);
        expect(response.json()).toMatchObject({ ok: true });
      },
      { allowedHosts: ["127.0.0.1"] },
    );
  });

  test("явный dev origin сравнивается дословно даже при канонически эквивалентном default port", async () => {
    await withServer(
      async ({ server }) => {
        const exact = await server.app.inject({
          method: "GET",
          url: "/api/v2/context",
          headers: { host: "127.0.0.1", origin: "http://localhost:80" },
        });
        const different = await server.app.inject({
          method: "GET",
          url: "/api/v2/context",
          headers: { host: "127.0.0.1", origin: "http://localhost" },
        });

        expect(exact.statusCode).toBe(200);
        expect(exact.headers["access-control-allow-origin"]).toBe("http://localhost:80");
        expect(different.statusCode).toBe(403);
        expect(different.json()).toMatchObject({ error: { code: "ORIGIN_FORBIDDEN" } });
      },
      { allowedHosts: defaultHosts, allowedOrigins: ["http://localhost:80"] },
    );
  });

  test.each(accepted)("$name допускается без привилегированного bind", async ({ host, origin }) => {
    await withServer(
      async ({ server, location }) => {
        const response = await server.app.inject({
          method: "GET",
          url: "/api/v2/context",
          headers: { host, origin },
        });

        expect(response.statusCode).toBe(200);
        expect(response.json()).toMatchObject({
          ok: true,
          data: { projects: [{ id: location.projectId }] },
        });
        expect(response.headers["access-control-allow-origin"]).toBe(origin);
      },
      { allowedHosts: defaultHosts, allowedOrigins: ["http://127.0.0.1:5173"] },
    );
  });

  test.each(forbiddenHosts)("Host %s не обходится канонизацией :80", async (host) => {
    await withServer(
      async ({ server }) => {
        const response = await server.app.inject({
          method: "GET",
          url: "/api/v2/context",
          headers: { host },
        });

        expect(response.statusCode).toBe(403);
        expect(response.json()).toMatchObject({ ok: false, error: { code: "HOST_FORBIDDEN" } });
      },
      { allowedHosts: defaultHosts },
    );
  });

  test.each(forbiddenOrigins)(
    "Origin %s не становится same-origin либо разрешённым dev origin",
    async (origin) => {
      await withServer(
        async ({ server }) => {
          const response = await server.app.inject({
            method: "GET",
            url: "/api/v2/context",
            headers: { host: "127.0.0.1", origin },
          });

          expect(response.statusCode).toBe(403);
          expect(response.json()).toMatchObject({ ok: false, error: { code: "ORIGIN_FORBIDDEN" } });
        },
        { allowedHosts: defaultHosts, allowedOrigins: ["http://127.0.0.1:5173"] },
      );
    },
  );

  test("нестандартный разрешённый порт остаётся точным и не разрешает Host без порта", async () => {
    await withServer(
      async ({ server }) => {
        const acceptedResponse = await server.app.inject({
          method: "GET",
          url: "/api/v2/context",
          headers: { host: "127.0.0.1:3210", origin: "http://127.0.0.1:3210" },
        });
        const refused = await server.app.inject({
          method: "GET",
          url: "/api/v2/context",
          headers: { host: "127.0.0.1" },
        });

        expect(acceptedResponse.statusCode).toBe(200);
        expect(refused.statusCode).toBe(403);
        expect(refused.json()).toMatchObject({ error: { code: "HOST_FORBIDDEN" } });
      },
      { allowedHosts: ["127.0.0.1:3210"] },
    );
  });

  test("cross-site без Origin остаётся запрещённым для стандартного порта", async () => {
    await withServer(
      async ({ server }) => {
        const response = await server.app.inject({
          method: "GET",
          url: "/api/v2/context",
          headers: { host: "127.0.0.1", "sec-fetch-site": "cross-site" },
        });

        expect(response.statusCode).toBe(403);
        expect(response.json()).toMatchObject({ error: { code: "ORIGIN_FORBIDDEN" } });
      },
      { allowedHosts: defaultHosts },
    );
  });
});
