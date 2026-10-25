import { describe, expect, test } from "bun:test";
import {
  RelayError,
  type GitSyncControlOutcome,
  type GitSyncRequest,
  type HttpGitSyncStatus,
} from "@relay/contracts";
import { withServer, apiError } from "./fixture";

const status: HttpGitSyncStatus = {
  connected: true,
  mode: "manual",
  phase: "idle",
  worker: { desired: "stopped", actual: "unknown", responsive: false },
  pending: { changesets: 2, unexported: null },
  conflicts: { count: 1, freshness: "partial", asOf: null },
  lastSuccess: null,
  error: null,
  freshness: { known: false, asOf: null, remoteHead: null },
};
const foreignOutcome = {
  version: 1,
  state: "completed",
  requestId: "other",
  instance: "worker",
  action: "now",
  acceptedAt: "2026-10-25T00:00:00.000Z",
  startedAt: "2026-10-25T00:00:00.000Z",
  completedAt: "2026-10-25T00:00:00.000Z",
  result: { exported: 2 },
} satisfies GitSyncControlOutcome;

describe("Nest → текущий Git Sync Runtime", () => {
  test("conflicts list/get сохраняют pending union без выдуманного fingerprint", async () => {
    const blocked = {
      id: "pending-changeset",
      state: "pending",
      code: "REPLICATION_DEPENDENCY",
      message: "Ожидает основу",
      dependencies: ["source"],
    } as const;
    const calls: GitSyncRequest[] = [];
    await withServer(
      async ({ client, location }) => {
        expect((await client.read(location.projectId, "gitSyncConflicts", {})).data).toEqual({
          conflicts: [],
          blocked: [blocked],
        });
        expect(
          (await client.read(location.projectId, "gitSyncConflict", { id: blocked.id })).data,
        ).toEqual(blocked);
        expect(calls.map((call) => ({ action: call.action, input: call.input }))).toEqual([
          { action: "conflicts.list", input: {} },
          { action: "conflicts.get", input: { id: blocked.id } },
        ]);
      },
      {
        gitSync: {
          request: async (request) => {
            calls.push(request);
            return request.action === "conflicts.list"
              ? { conflicts: [], blocked: [blocked] }
              : blocked;
          },
        },
      },
    );
  });

  test("cached status сохраняет unknown/partial/null и явно передаёт refresh:false", async () => {
    const calls: GitSyncRequest[] = [];
    await withServer(
      async ({ client, location }) => {
        expect((await client.read(location.projectId, "gitSyncStatus", {})).data).toEqual(status);
        expect(calls).toHaveLength(1);
        expect(calls[0]).toMatchObject({ version: 1, action: "status", input: { refresh: false } });
      },
      {
        gitSync: {
          request: async (request) => {
            calls.push(request);
            return structuredClone(status);
          },
        },
      },
    );
  });

  test.each([
    { name: "пустой status", value: {} },
    { name: "отсутствует nullable дата", value: { ...status, lastSuccess: undefined } },
    { name: "нет секции worker", value: { ...status, worker: undefined } },
    {
      name: "счётчик строкой",
      value: { ...status, pending: { changesets: "2", unexported: null } },
    },
    {
      name: "неизвестное значение freshness",
      value: { ...status, conflicts: { count: 0, freshness: "fresh", asOf: null } },
    },
  ])("$name не превращается в успешный unknown", async ({ value }) => {
    await withServer(
      async ({ client, location }) => {
        await apiError(
          () => client.read(location.projectId, "gitSyncStatus", {}),
          "GIT_SYNC_INVALID_RESPONSE",
          500,
        );
      },
      { gitSync: { request: async () => value } },
    );
  });

  test("now принимает настоящий summary, затем отдельно читает коррелированный retained outcome", async () => {
    const calls: GitSyncRequest[] = [];
    let requestId = "";
    const timestamp = "2026-10-25T00:00:00.000Z";
    await withServer(
      async ({ client, location }) => {
        const result = await client.gitSyncNow(location.projectId);
        expect(result.data).toEqual({
          version: 1,
          state: "completed",
          requestId,
          instance: "worker",
          action: "now",
          acceptedAt: timestamp,
          startedAt: timestamp,
          completedAt: timestamp,
          result: { exported: 2 },
        });
        expect(calls.map((call) => call.action)).toEqual(["now", "request.get"]);
        expect(calls[0]?.input).toEqual({ operationId: requestId });
        expect(calls[1]?.input).toEqual({ requestId });
        expect(
          (await client.read(location.projectId, "gitSyncRequest", { requestId })).data,
        ).toEqual(result.data);
        expect(calls.filter((call) => call.action === "now")).toHaveLength(1);
      },
      {
        gitSync: {
          request: async (request) => {
            calls.push(request);
            if (request.action === "now") {
              const id = request.input?.operationId;
              if (typeof id !== "string") {
                throw new Error("operationId должен назначаться до submit");
              }
              requestId = id;
              return { exported: 2, imported: 0, requestId };
            }
            return {
              version: 1,
              state: "completed",
              requestId,
              instance: "worker",
              action: "now",
              acceptedAt: timestamp,
              startedAt: timestamp,
              completedAt: timestamp,
              result: { exported: 2 },
            };
          },
        },
      },
    );
  });

  test("timeout сохраняет requestId без повторного submit и позволяет явно прочитать unknown исход", async () => {
    const actions: string[] = [];
    let requestId = "";
    await withServer(
      async ({ client, location }) => {
        const failure = await apiError(
          () => client.gitSyncNow(location.projectId),
          "GIT_SYNC_WAIT_TIMEOUT",
          409,
        );
        expect(failure.details).toMatchObject({ requestId, state: "running", instance: "worker" });
        expect(actions).toEqual(["now"]);
        expect(
          (await client.read(location.projectId, "gitSyncRequest", { requestId })).data,
        ).toEqual({ version: 1, requestId, state: "unknown", instance: null });
        expect(actions).toEqual(["now", "request.get"]);
      },
      {
        gitSync: {
          request: async (request) => {
            actions.push(request.action);
            if (request.action === "now") {
              const id = request.input?.operationId;
              if (typeof id !== "string") {
                throw new Error("Нет requestId");
              }
              requestId = id;
              throw new RelayError("GIT_SYNC_WAIT_TIMEOUT", "Ожидание завершено", 4, {
                requestId,
                state: "running",
                instance: "worker",
              });
            }
            return { version: 1, requestId, state: "unknown", instance: null };
          },
        },
      },
    );
  });

  test("now отвергает валидный summary с чужим requestId до чтения outcome", async () => {
    const actions: string[] = [];
    await withServer(
      async ({ client, location }) => {
        await apiError(
          () => client.gitSyncNow(location.projectId),
          "GIT_SYNC_INVALID_RESPONSE",
          500,
        );

        expect(actions).toEqual(["now"]);
      },
      {
        gitSync: {
          request: async (request) => {
            actions.push(request.action);
            if (request.action === "now") {
              return { exported: 2, imported: 0, requestId: "other" };
            }
            // Если summary ошибочно принят, следующий ответ валиден и не маскирует потерю guard.
            return { ...foreignOutcome, requestId: request.input?.requestId };
          },
        },
      },
    );
  });

  test.each([
    { name: "явный request.get", viaNow: false },
    { name: "request.get после now", viaNow: true },
  ])("$name отвергает полностью валидный outcome с чужим requestId", async ({ viaNow }) => {
    const actions: string[] = [];
    await withServer(
      async ({ client, location }) => {
        await apiError(
          () =>
            viaNow
              ? client.gitSyncNow(location.projectId)
              : client.read(location.projectId, "gitSyncRequest", { requestId: "requested" }),
          "GIT_SYNC_INVALID_RESPONSE",
          500,
        );

        expect(actions).toEqual(viaNow ? ["now", "request.get"] : ["request.get"]);
      },
      {
        gitSync: {
          request: async (request) => {
            actions.push(request.action);
            return request.action === "now"
              ? { exported: 2, imported: 0, requestId: request.input?.operationId }
              : structuredClone(foreignOutcome);
          },
        },
      },
    );
  });

  test("неполный outcome с правильным requestId отвергается при now и явном чтении", async () => {
    await withServer(
      async ({ client, location }) => {
        await apiError(
          () => client.gitSyncNow(location.projectId),
          "GIT_SYNC_INVALID_RESPONSE",
          500,
        );
        await apiError(
          () => client.read(location.projectId, "gitSyncRequest", { requestId: "requested" }),
          "GIT_SYNC_INVALID_RESPONSE",
          500,
        );
      },
      {
        gitSync: {
          request: async (request) =>
            request.action === "now"
              ? { exported: 2, imported: 0, requestId: request.input?.operationId }
              : { version: 1, state: "completed", requestId: request.input?.requestId },
        },
      },
    );
  });

  test("отсутствующий Runtime client даёт 503, а HTTP now не принимает process options", async () => {
    await withServer(async ({ client, location, server }) => {
      await apiError(
        () => client.read(location.projectId, "gitSyncStatus", {}),
        "GIT_SYNC_UNAVAILABLE",
        503,
      );
      const response = await fetch(
        `${server.url}api/v2/projects/${location.projectId}/git-sync/now`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ waitMs: 0 }),
        },
      );
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: { code: "INVALID_ARGUMENT" } });
    });
  });
});
