import { describe, expect, test } from "bun:test";
import { RequestMethod } from "@nestjs/common";
import { METHOD_METADATA, PATH_METADATA } from "@nestjs/common/constants";
import { API_CONTROLLERS } from "../../src/server.module";
import { HTTP_OPERATIONS } from "../../src/http/operations";
import { OPERATION_METADATA } from "../../src/http/operation";
import { createRelayServer } from "../../src/server";
import { withServer } from "./fixture";

describe("Полнота настоящих Nest routes", () => {
  test("каждая Contracts операция имеет ровно один handler и фактический Fastify route", async () => {
    await withServer(async ({ server }) => {
      const seen = new Map<string, { path: string; method: string }>();
      for (const controller of API_CONTROLLERS) {
        for (const name of Object.getOwnPropertyNames(controller.prototype)) {
          const descriptor = Object.getOwnPropertyDescriptor(controller.prototype, name);
          const handler: unknown = descriptor?.value;
          if (typeof handler !== "function") {
            continue;
          }
          const operation: unknown = Reflect.getMetadata(OPERATION_METADATA, handler);
          if (typeof operation !== "string") {
            continue;
          }
          expect(seen.has(operation)).toBe(false);
          const path: unknown = Reflect.getMetadata(PATH_METADATA, handler);
          const method: unknown = Reflect.getMetadata(METHOD_METADATA, handler);
          if (
            typeof path !== "string" ||
            (method !== RequestMethod.GET && method !== RequestMethod.POST)
          ) {
            throw new Error("Некорректные Nest route metadata");
          }
          seen.set(operation, { path, method: method === RequestMethod.GET ? "GET" : "POST" });
          expect(
            server.app
              .getHttpAdapter()
              .getInstance()
              .hasRoute({ method: method === RequestMethod.GET ? "GET" : "POST", url: path }),
          ).toBe(true);
        }
      }
      expect([...seen.keys()].sort()).toEqual(Object.keys(HTTP_OPERATIONS).sort());
      for (const [name, route] of Object.entries(HTTP_OPERATIONS)) {
        expect(seen.get(name)).toEqual({
          method: route.method,
          path: route.path.replace(/\{([^}]+)\}/g, ":$1"),
        });
      }
    });
  });

  test("createRelayServer работает через inject без listener с настоящими guard и контроллером", async () => {
    await withServer(async ({ runtime, location }) => {
      const application = await createRelayServer({ runtime, version: "inject", actor: "Автор" });
      try {
        expect(application.app.getHttpServer().listening).toBe(false);
        const response = await application.app.inject({
          method: "GET",
          url: "/api/v2/context",
          headers: { host: "localhost" },
        });
        expect(response.statusCode).toBe(200);
        expect(response.json()).toMatchObject({
          ok: true,
          data: { version: "inject", actor: "Автор", projects: [{ id: location.projectId }] },
        });
      } finally {
        await application.close();
      }
    });
  });
});
