import { describe, expect, test } from "bun:test";
import { createRelayClient } from "@relay/rest-sdk";
import type { HttpGitSyncStatus } from "@relay/contracts";
import { createProjectSynchronization, ProjectSynchronizationError } from "./synchronization";
import { projectSynchronization } from "./synchronization-mapper";

const cached: HttpGitSyncStatus = {
  connected: true,
  mode: "manual",
  phase: "idle",
  worker: { desired: "stopped", actual: "stopped", responsive: null },
  pending: { changesets: 0, unexported: 0 },
  conflicts: { count: 0, freshness: "current", asOf: "2026-10-26T00:00:00Z" },
  lastSuccess: "2026-10-26T00:00:00Z",
  error: null,
  freshness: { known: true, asOf: "2026-10-26T00:00:00Z", remoteHead: "head" },
};
const identity = {
  version: 1,
  requestId: "request-1",
  instance: "instance",
  action: "now",
  acceptedAt: "2026-10-26T00:00:00Z",
  startedAt: null,
};

/**
 * Отдаёт тестовый HTTP envelope через настоящий SDK без реального Git/Server.
 */
function response(data: unknown): Response {
  return Response.json({ ok: true, data });
}

/**
 * Подключает HTTP fixture к SDK, включая обязательный Bun fetch.preconnect без сети.
 */
function fixtureFetch(
  handler: (
    url: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ) => Promise<Response>,
): typeof fetch {
  return Object.assign(handler, { preconnect: () => {} });
}

describe("Наблюдение ручного Git Sync", () => {
  test("неизвестное число неэкспортированных изменений не становится synced или false", () => {
    const status = projectSynchronization({
      ...cached,
      pending: { changesets: 0, unexported: null },
    });

    expect(status.state).toBe("unknown");
    expect(status.hasUncommittedChanges).toBeNull();
  });

  test("полностью потерянный ответ без requestId запрещает второй now", async () => {
    let writes = 0;
    const api = createProjectSynchronization(
      createRelayClient({
        baseUrl: "http://relay.test",
        fetch: fixtureFetch(async (_url, init) => {
          if (init?.method === "POST") {
            writes++;
            throw new TypeError("Потерян ответ");
          }
          return response(cached);
        }),
      }),
    );

    await expect(api.request("project")).rejects.toBeInstanceOf(ProjectSynchronizationError);
    await expect(api.request("project")).rejects.toBeInstanceOf(ProjectSynchronizationError);
    const status = await api.status("project");

    expect(writes).toBe(1);
    expect(status.requestState).toBe("unknown");
    expect(status.requestId).toBeNull();
    expect((await api.status("other-project")).requestState).toBeNull();
  });

  test("queued наблюдается периодическим чтением исхода без повторного now", async () => {
    let writes = 0;
    let reads = 0;
    const api = createProjectSynchronization(
      createRelayClient({
        baseUrl: "http://relay.test",
        fetch: fixtureFetch(async (url, init) => {
          if (init?.method === "POST") {
            writes++;
            return response({ ...identity, state: "queued" });
          }
          if (String(url).includes("/requests/")) {
            reads++;
            return response({
              ...identity,
              state: "completed",
              completedAt: "2026-10-26T00:00:01Z",
              result: {},
            });
          }
          return response(cached);
        }),
      }),
    );

    const accepted = await api.request("project");
    const finished = await api.status("project");
    await api.status("project");

    expect(accepted.requestState).toBe("queued");
    expect(finished.requestState).toBe("completed");
    expect(writes).toBe(1);
    expect(reads).toBe(1);
  });

  test.each([
    { name: "оболочка", body: { unexpected: true } },
    { name: "исход", body: { ok: true, data: {} } },
  ])(
    "невалидный успешный HTTP-ответ ($name) не разрешает повторить неизвестный now",
    async ({ body }) => {
      let writes = 0;
      const api = createProjectSynchronization(
        createRelayClient({
          baseUrl: "http://relay.test",
          fetch: fixtureFetch(async (_url, init) => {
            if (init?.method === "POST") {
              writes++;
              return Response.json(body);
            }
            return response(cached);
          }),
        }),
      );

      await expect(api.request("project")).rejects.toBeInstanceOf(ProjectSynchronizationError);
      await expect(api.request("project")).rejects.toBeInstanceOf(ProjectSynchronizationError);

      expect(writes).toBe(1);
      expect((await api.status("project")).requestState).toBe("unknown");
    },
  );

  test("timeout с ID проверяется GET и сохраняет фактический failed", async () => {
    let writes = 0;
    const api = createProjectSynchronization(
      createRelayClient({
        baseUrl: "http://relay.test",
        fetch: fixtureFetch(async (url, init) => {
          if (init?.method === "POST") {
            writes++;
            return Response.json(
              {
                ok: false,
                error: {
                  code: "GIT_SYNC_TIMEOUT",
                  message: "Timeout",
                  details: { requestId: "request-1" },
                },
              },
              { status: 504 },
            );
          }
          if (String(url).includes("/requests/request-1"))
            return response({
              ...identity,
              state: "failed",
              completedAt: "2026-10-26T00:00:01Z",
              error: { code: "FAILED", message: "Фактический отказ", exitCode: 1 },
            });
          return response(cached);
        }),
      }),
    );

    await expect(api.request("project")).rejects.toBeInstanceOf(ProjectSynchronizationError);
    const status = await api.status("project");

    expect(writes).toBe(1);
    expect(status.requestState).toBe("failed");
    expect(status.requestError).toBe("Фактический отказ");
  });

  test("одновременные действия разделяют один HTTP-запрос проекта", async () => {
    let writes = 0;
    let finish: (value: Response) => void = () => {
      throw new Error("Не создано ожидание");
    };
    const pending = new Promise<Response>((resolve) => {
      finish = resolve;
    });
    const api = createProjectSynchronization(
      createRelayClient({
        baseUrl: "http://relay.test",
        fetch: fixtureFetch(async (_url, init) => {
          if (init?.method === "POST") {
            writes++;
            return pending;
          }
          return response(cached);
        }),
      }),
    );

    const first = api.request("project");
    const second = api.request("project");
    finish(response({ ...identity, state: "queued" }));
    await Promise.all([first, second]);

    expect(second).toBe(first);
    expect(writes).toBe(1);
  });

  test("поздний исход прежнего запроса не заменяет уже начатый следующий", async () => {
    let writes = 0;
    let outcomeReads = 0;
    let finish: (value: Response) => void = () => {
      throw new Error("Не создано ожидание");
    };
    const late = new Promise<Response>((resolve) => {
      finish = resolve;
    });
    const api = createProjectSynchronization(
      createRelayClient({
        baseUrl: "http://relay.test",
        fetch: fixtureFetch(async (url, init) => {
          if (init?.method === "POST") {
            writes++;
            return response({ ...identity, requestId: `request-${writes}`, state: "queued" });
          }
          if (String(url).includes("/requests/")) {
            outcomeReads++;
            if (outcomeReads === 1) return late;
            return response({
              ...identity,
              state: "completed",
              completedAt: "2026-10-26T00:00:01Z",
              result: {},
            });
          }
          return response(cached);
        }),
      }),
    );
    await api.request("project");

    const oldRead = api.status("project");
    await api.status("project");
    const next = await api.request("project");
    finish(
      response({
        ...identity,
        state: "completed",
        completedAt: "2026-10-26T00:00:01Z",
        result: {},
      }),
    );
    const afterLateResponse = await oldRead;

    expect(next.requestId).toBe("request-2");
    expect(afterLateResponse.requestId).toBe("request-2");
    expect(afterLateResponse.requestState).toBe("queued");
    expect(writes).toBe(2);
  });
});
