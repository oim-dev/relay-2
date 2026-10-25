import { describe, expect, test } from "bun:test";
import type { IncomingMessage } from "node:http";
import { KnowledgeService, QueryService } from "@relay/core";
import openapi from "../../openapi.json";
import { apiError, withServer } from "./fixture";

describe("Адреса Core через Nest и SDK", () => {
  test.each([".", "..", "Документ/%2E/#?&=+🙂"])(
    "ключ %s после Core rename читается без потери адреса, версии и лишних HTTP-запросов",
    async (key) => {
      await withServer(async ({ client, server, location, database }) => {
        const expected = await database(async (db) => {
          const knowledge = new KnowledgeService(db);
          const initial = await knowledge.create(
            "document",
            { name: "Исходная карточка", body: "Содержание до переименования" },
            "CLI",
          );
          const renamed = await knowledge.rename("document", initial.id, key, {
            actor: "CLI",
            ifRevision: initial.revision,
          });
          const query = new QueryService(db);
          return {
            renamed,
            entity: query.get(key),
            versioned: await query.getManyVersioned([key]),
            links: knowledge.documentLinks(key),
          };
        });
        const requests: string[] = [];
        server.app.getHttpServer().on("request", (request: IncomingMessage) => {
          requests.push(request.url ?? "");
        });

        const versioned = await client.entity(location.projectId, key, { withVersions: true });

        expect(requests).toHaveLength(1);
        const address = new URL(requests[0] ?? "", server.url);
        expect(address.pathname).toBe(`/api/v2/projects/${location.projectId}/entity`);
        expect(address.searchParams.getAll("ref")).toEqual([key]);
        expect(address.searchParams.get("withVersions")).toBe("true");
        expect(versioned.data).toEqual(expected.entity);
        expect(versioned.data).toMatchObject({
          id: expected.renamed.id,
          key,
          revision: expected.renamed.revision,
        });
        expect(versioned.meta).toEqual({
          versions: expected.versioned.versions,
          generation: expected.versioned.data.generation,
        });

        const plain = await client.entity(location.projectId, key);

        expect(requests).toHaveLength(2);
        expect(plain).toEqual({ ok: true, data: expected.entity });

        const links = await client.read(location.projectId, "documentLinks", { ref: key });

        expect(requests).toHaveLength(3);
        expect(links.data).toEqual(expected.links);
        expect(links.data).toMatchObject({ ref: key, revision: expected.renamed.revision });

        const typed = await client.read(location.projectId, "documentLinks", {
          ref: `document:${key}`,
        });

        expect(requests).toHaveLength(4);
        expect(typed).toEqual(links);
        await apiError(
          () => client.read(location.projectId, "documentLinks", { ref: `task:${key}` }),
          "INVALID_ARGUMENT",
          400,
        );
        expect(requests).toHaveLength(5);
      });
    },
  );

  test.each([
    { name: "отсутствующий ref", query: "", code: "INVALID_ARGUMENT" },
    { name: "повтор одного ref", query: "?ref=..&ref=..", code: "INVALID_ARGUMENT" },
    { name: "два разных ref", query: "?ref=..&ref=.", code: "INVALID_ARGUMENT" },
    { name: "пустой ref", query: "?ref=", code: "VALIDATION_ERROR" },
  ])("$name отклоняется как ошибка адреса", async ({ query, code }) => {
    await withServer(async ({ server, location }) => {
      const response = await fetch(
        new URL(`/api/v2/projects/${location.projectId}/entity${query}`, server.url),
      );

      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        ok: false,
        error: { code, details: { field: "ref" } },
      });
    });
  });

  test("OpenAPI entity публикует обязательный одиночный query ref вместо path ref", () => {
    const operation = openapi.paths["/api/v2/projects/{projectId}/entity"].get;

    expect(operation.operationId).toBe("entity");
    expect(operation.parameters.filter((parameter) => parameter.name === "ref")).toEqual([
      {
        name: "ref",
        in: "query",
        required: true,
        schema: {
          type: "string",
          minLength: 1,
          description: expect.any(String),
        },
      },
    ]);
    expect(operation.parameters).toContainEqual({
      name: "withVersions",
      in: "query",
      required: false,
      schema: { type: "boolean" },
    });
    expect(Object.keys(openapi.paths)).not.toContain("/api/v2/projects/{projectId}/entities/{ref}");
  });
});
