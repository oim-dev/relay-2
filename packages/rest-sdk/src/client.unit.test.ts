import { describe, expect, test } from "bun:test";
import type { BatchResult, EntityReadResult } from "@relay/contracts";
import { createRelayClient } from "./client";
import { RelayApiError } from "./errors";
import { createRelayTransport } from "./transport";

/**
 * Подменяет только Fetch boundary без изменения globalThis; транспорт получает настоящий Request.
 */
function fetchBoundary(handler: (request: Request) => Response | Promise<Response>): typeof fetch {
  return Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> =>
      await handler(new Request(input, init)),
    { preconnect: fetch.preconnect },
  );
}

/**
 * Извлекает именно публичную ошибку SDK, отвергая случайный TypeError либо успешный ответ.
 */
async function apiError(pending: Promise<unknown>): Promise<RelayApiError> {
  try {
    await pending;
  } catch (error) {
    expect(error).toBeInstanceOf(RelayApiError);
    if (error instanceof RelayApiError) {
      return error;
    }
    throw error;
  }
  throw new Error("Ожидался отказ SDK");
}

describe("Generated HTTP transport и стабильный facade", () => {
  test("пустой обязательный ref отклоняет Promise до Fetch", async () => {
    let requests = 0;
    const client = createRelayClient({
      baseUrl: "https://relay.test",
      fetch: fetchBoundary(() => {
        requests++;
        return Response.json({ ok: true, data: {} });
      }),
    });

    const error = await apiError(client.entity("project", ""));

    expect(error).toMatchObject({ code: "INVALID_ARGUMENT", status: 0 });
    expect(requests).toBe(0);
  });

  test.each([".", "..", "ключ /?#&=+% Юникод", "document:.."])(
    "entity передаёт исходный query ref %s ровно одним запросом",
    async (ref) => {
      const requests: URL[] = [];
      const client = createRelayClient({
        baseUrl: "https://relay.test",
        fetch: fetchBoundary((request) => {
          requests.push(new URL(request.url));
          return Response.json(
            { ok: false, error: { code: "NOT_FOUND", message: "Нет записи" } },
            { status: 404 },
          );
        }),
      });

      const error = await apiError(client.entity("project /#?%", ref, { withVersions: false }));

      expect(error.code).toBe("NOT_FOUND");
      expect(requests).toHaveLength(1);
      expect(requests[0]?.pathname).toBe("/api/v2/projects/project%20%2F%23%3F%25/entity");
      expect(requests[0]?.searchParams.getAll("ref")).toEqual([ref]);
      expect(requests[0]?.searchParams.get("withVersions")).toBe("false");
      expect(requests[0]?.hash).toBe("");
    },
  );

  test.each([
    { operation: "documentLinks", path: "documents/document%3A../links" },
    { operation: "applicationParticipation", path: "applications/application%3A../participation" },
    { operation: "taskProgress", path: "tasks/task%3A../progress" },
    { operation: "taskComments", path: "tasks/task%3A../comments" },
    { operation: "taskComment", path: "tasks/task%3A../comments/nested" },
    { operation: "taskCriteria", path: "tasks/task%3A../criteria" },
    { operation: "taskCriterion", path: "tasks/task%3A../criteria/nested" },
    { operation: "taskDependencies", path: "tasks/task%3A../dependencies" },
    { operation: "taskChildren", path: "tasks/task%3A../children" },
    { operation: "taskRelated", path: "tasks/task%3A../related" },
    { operation: "taskMemberships", path: "tasks/task%3A../memberships" },
    { operation: "planProgress", path: "plans/work-plan%3A../progress" },
    { operation: "planStages", path: "plans/work-plan%3A../stages" },
    { operation: "planStage", path: "plans/work-plan%3A../stages/stage" },
    { operation: "planStageTasks", path: "plans/work-plan%3A../stages/stage/tasks" },
    { operation: "releaseProgress", path: "releases/release%3A../progress" },
    { operation: "releasePlans", path: "releases/release%3A../plans" },
    { operation: "historySession", path: "history/sessions/work-session%3A.." },
    { operation: "historyContext", path: "history/sessions/work-session%3A../context" },
    { operation: "historyTree", path: "history/sessions/work-session%3A../tree" },
    { operation: "historyIntents", path: "history/sessions/work-session%3A../intents" },
    { operation: "historyCheckpoint", path: "history/checkpoints/work-checkpoint%3A.." },
  ] as const)(
    "$operation сохраняет dot-ref с точным видом владельца",
    async ({ operation, path }) => {
      const requests: URL[] = [];
      const client = createRelayClient({
        baseUrl: "https://relay.test",
        fetch: fetchBoundary((request) => {
          requests.push(new URL(request.url));
          return Response.json(
            { ok: false, error: { code: "NOT_FOUND", message: "Нет записи" } },
            { status: 404 },
          );
        }),
      });

      await apiError(
        client.read("project", operation, { ref: "..", id: "nested", stageId: "stage" }),
      );

      expect(requests).toHaveLength(1);
      expect(requests[0]?.pathname).toBe(`/api/v2/projects/project/${path}`);
    },
  );

  test.each(["document:..", "task:..", "...", "../ключ /?#%🙂"])(
    "профильный reader сохраняет остальные ref %s без повторного encoding",
    async (ref) => {
      const requests: URL[] = [];
      const client = createRelayClient({
        baseUrl: "https://relay.test",
        fetch: fetchBoundary((request) => {
          requests.push(new URL(request.url));
          return Response.json(
            { ok: false, error: { code: "NOT_FOUND", message: "Нет записи" } },
            { status: 404 },
          );
        }),
      });

      await apiError(client.read("project", "documentLinks", { ref }));

      expect(requests).toHaveLength(1);
      const segments = requests[0]?.pathname.split("/");
      expect(segments?.map((segment) => decodeURIComponent(segment))).toEqual([
        "",
        "api",
        "v2",
        "projects",
        "project",
        "documents",
        ref,
        "links",
      ]);
      expect(requests[0]?.search).toBe("");
      expect(requests[0]?.hash).toBe("");
    },
  );

  test.each([200, 409, 503])(
    "error envelope при HTTP %i сохраняет details и status",
    async (status) => {
      const client = createRelayClient({
        baseUrl: "https://relay.test",
        fetch: fetchBoundary(() =>
          Response.json(
            {
              ok: false,
              error: {
                code: "REVISION_CONFLICT",
                message: "Исходная ревизия устарела",
                details: { expected: 7, actual: 8, requestId: "original" },
              },
            },
            { status },
          ),
        ),
      });

      const error = await apiError(client.context());

      expect(error).toMatchObject({
        status,
        code: "REVISION_CONFLICT",
        message: "Исходная ревизия устарела",
        details: { expected: 7, actual: 8, requestId: "original" },
      });
    },
  );

  test.each([200, 502])(
    "невалидный JSON при HTTP %i сохраняет SyntaxError как cause",
    async (status) => {
      const client = createRelayClient({
        baseUrl: "https://relay.test",
        fetch: fetchBoundary(() => new Response("<html>upstream</html>", { status })),
      });

      const error = await apiError(client.context());

      expect(error.code).toBe("INVALID_RESPONSE");
      expect(error.status).toBe(status);
      expect(error.cause).toBeInstanceOf(SyntaxError);
    },
  );

  test.each([
    { name: "без data", status: 200, body: { ok: true } },
    { name: "неполная ошибка", status: 403, body: { ok: false, error: { code: "DENIED" } } },
    { name: "успех при non-2xx", status: 502, body: { ok: true, data: {} } },
  ])("неверный envelope: $name отвергается без успешного fallback", async ({ status, body }) => {
    const client = createRelayClient({
      baseUrl: "https://relay.test",
      fetch: fetchBoundary(() => Response.json(body, { status })),
    });

    const error = await apiError(client.context());

    expect(error).toMatchObject({ code: "INVALID_RESPONSE", status });
  });

  test.each([".", "..", "ключ /?#&=+% Юникод"])(
    "receipt сохраняет исходный query-ключ %s",
    async (operationKey) => {
      let received: URL | undefined;
      const receipt: BatchResult = {
        operationKey,
        status: "committed",
        replayed: true,
        items: [],
        entities: [],
      };
      const client = createRelayClient({
        baseUrl: "https://relay.test/",
        fetch: fetchBoundary((request) => {
          received = new URL(request.url);
          return Response.json({ ok: true, data: receipt });
        }),
      });

      const response = await client.receipt("project /#?%", operationKey);

      expect(received?.pathname).toBe("/api/v2/projects/project%20%2F%23%3F%25/receipts");
      expect(received?.searchParams.getAll("operationKey")).toEqual([operationKey]);
      expect(response.data).toEqual(receipt);
    },
  );

  test("query сохраняет повторы адресов, false и порядок; metadata возвращается рядом с data", async () => {
    let received: URL | undefined;
    const data: EntityReadResult = { view: "full", items: [], generation: 0 };
    const meta = {
      generation: 0,
      versions: { entity: { recordVersion: "r1", aggregateVersion: "a1" } },
    };
    const client = createRelayClient({
      baseUrl: "https://relay.test",
      fetch: fetchBoundary((request) => {
        received = new URL(request.url);
        return Response.json({ ok: true, data, meta });
      }),
    });

    const response = await client.read("project", "getMany", {
      query: { ref: ["a /?#%", "b", "a /?#%"], summary: false, withVersions: true },
    });

    expect(received?.searchParams.getAll("ref")).toEqual(["a /?#%", "b", "a /?#%"]);
    expect(received?.searchParams.get("summary")).toBe("false");
    expect(received?.searchParams.get("withVersions")).toBe("true");
    expect(response).toEqual({ ok: true, data, meta });
  });

  test("запись сериализует первоначальные guards и operationKey один раз при сетевом отказе", async () => {
    const failure = new TypeError("Соединение потеряно после отправки");
    const body = Object.freeze({
      op: "document.update",
      ref: "DOC-1",
      actor: "Автор",
      operationKey: "original-operation",
      ifRevision: 7,
      expectedVersion: "aggregate-token",
      expectedAddresses: [{ ref: "DOC-1", expectedId: "document-id" }],
      input: { body: "Новое содержание" },
    });
    const requests: Request[] = [];
    const client = createRelayClient({
      baseUrl: "https://relay.test",
      fetch: fetchBoundary((request) => {
        requests.push(request);
        throw failure;
      }),
    });

    await expect(client.command("project", body)).rejects.toBe(failure);

    expect(requests).toHaveLength(1);
    expect(requests[0]?.method).toBe("POST");
    expect(requests[0]?.headers.get("content-type")).toBe("application/json");
    expect(requests[0]?.headers.get("accept")).toBe("application/json");
    expect(await requests[0]?.json()).toEqual(body);
  });

  test("страница передаёт нулевой offset и false-фильтр без подстановки defaults", async () => {
    let received: URL | undefined;
    const client = createRelayClient({
      baseUrl: "https://relay.test",
      fetch: fetchBoundary((request) => {
        received = new URL(request.url);
        return Response.json({
          ok: true,
          data: { items: [], total: 0, offset: 0, limit: 5, generation: 0, nextOffset: null },
        });
      }),
    });

    await client.entities("project", { kind: "task", offset: 0, limit: 5, root: false });

    expect(received?.searchParams.get("offset")).toBe("0");
    expect(received?.searchParams.get("root")).toBe("false");
    expect(received?.searchParams.get("limit")).toBe("5");
    expect(received?.searchParams.has("generation")).toBe(false);
  });

  test("параллельные ответы сохраняют собственные status и requestId при обратном порядке", async () => {
    const firstResponse = Promise.withResolvers<Response>();
    let requests = 0;
    const client = createRelayClient({
      baseUrl: "https://relay.test",
      fetch: fetchBoundary(() => {
        requests++;
        if (requests === 1) {
          return firstResponse.promise;
        }
        return Response.json(
          {
            ok: false,
            error: { code: "SECOND", message: "Второй отказ", details: { requestId: "second" } },
          },
          { status: 503 },
        );
      }),
    });
    const first = apiError(client.context());
    const second = await apiError(client.context());
    firstResponse.resolve(
      Response.json(
        {
          ok: false,
          error: { code: "FIRST", message: "Первый отказ", details: { requestId: "first" } },
        },
        { status: 409 },
      ),
    );

    const initial = await first;

    expect(second).toMatchObject({ code: "SECOND", status: 503, details: { requestId: "second" } });
    expect(initial).toMatchObject({ code: "FIRST", status: 409, details: { requestId: "first" } });
    expect(requests).toBe(2);
  });

  test("generated transport передаёт исходную причину AbortSignal без retry", async () => {
    const controller = new AbortController();
    const reason = new DOMException("Вызов отменён", "AbortError");
    let calls = 0;
    const transport = createRelayTransport({
      baseUrl: "https://relay.test",
      fetch: fetchBoundary((request) => {
        calls++;
        expect(request.signal.aborted).toBe(true);
        throw request.signal.reason;
      }),
    });
    controller.abort(reason);

    await expect(
      transport.request({
        path: "/api/v2/context",
        method: "GET",
        format: "json",
        signal: controller.signal,
      }),
    ).rejects.toBe(reason);

    expect(calls).toBe(1);
  });
});
