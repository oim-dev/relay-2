import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { RelayError, type GitSyncRequest } from "@relay/contracts";
import type { GitSyncClient } from "@relay/project-runtime";
import { withCliFixture } from "../../../tests/integration/helpers/cli-fixture";
import { invokeIsolatedCli } from "../../../tests/helpers/help";

const group = "git-sync-implementation/cli-runtime/request-correlation";

/**
 * Подменяет только процессный порт; API восстановления ожидания не запускает service/foreground fallback.
 */
function operationPort(request: GitSyncClient["request"]): GitSyncClient {
  return {
    request,
    /**
     * Обнаруживает недопустимую установку службы при timeout/query.
     */
    service: async (): Promise<never> => {
      throw new Error("Неожиданный service fallback");
    },
    /**
     * Обнаруживает недопустимый запуск нового supervisor вместо чтения outcome.
     */
    supervise: async (): Promise<never> => {
      throw new Error("Неожиданный foreground fallback");
    },
  };
}

describe("CLI correlation явных Git Sync запросов", () => {
  test.each([
    {
      args: ["now", "--request-id", "known-id", "--wait-ms", "12"],
      action: "now",
      input: { requestId: "known-id", waitMs: 12 },
    },
    {
      args: ["request", "get", "known-id"],
      action: "request.get",
      input: { requestId: "known-id" },
    },
    {
      args: ["status", "--refresh", "--request-id", "known-id", "--wait-ms", "15"],
      action: "status",
      input: { refresh: true, requestId: "known-id", waitMs: 15 },
    },
  ])(
    "$action передаёт ровно одно ожидание/query без operationId",
    async ({ args, action, input }) => {
      await withCliFixture(async (fixture) => {
        const calls: GitSyncRequest[] = [];

        await fixture.success(["git-sync", ...args], {
          gitSync: operationPort(async (request) => {
            calls.push(request);
            return { requestId: "known-id", state: "completed" };
          }),
        });

        expect(calls).toHaveLength(1);
        expect(calls[0]).toMatchObject({ version: 1, action, input });
        expect(calls[0]?.input).toEqual(input);
      }, group);
    },
  );

  test("request get unknown остаётся наблюдением unknown, без результата и повторного submit", async () => {
    await withCliFixture(async (fixture) => {
      const calls: GitSyncRequest[] = [];
      const outcome = { version: 1, requestId: "expired-id", instance: null, state: "unknown" };

      const response = await fixture.success(["git-sync", "request", "get", "expired-id"], {
        gitSync: operationPort(async (request) => {
          calls.push(request);
          return outcome;
        }),
      });

      expect(response.data).toEqual(outcome);
      expect(response.data).not.toHaveProperty("result");
      expect(calls.map((request) => request.action)).toEqual(["request.get"]);
    }, group);
  });

  test.each([
    { code: "GIT_SYNC_WAIT_TIMEOUT", exit: 4, state: "queued" },
    { code: "GIT_SYNC_OUTCOME_UNKNOWN", exit: 4, state: "unknown" },
    { code: "GIT_SYNC_TIMEOUT", exit: 124, state: "unknown" },
  ])("$code сохраняет ID/state/exit без retry", async ({ code, exit, state }) => {
    await withCliFixture(async (fixture) => {
      let calls = 0;
      const details = { requestId: "recover-this-id", state, instance: "owner" };
      const port = operationPort(async () => {
        calls++;
        throw new RelayError(code, "Исход ожидания", exit, details);
      });

      const error = await fixture.error(
        ["git-sync", "now", "--request-id", "recover-this-id"],
        exit,
        { gitSync: port },
      );

      expect(error).toMatchObject({ code, details });
      expect(error.message).toContain("recover-this-id");
      expect(calls).toBe(1);
    }, group);
  });

  test("текстовая timeout-диагностика тоже содержит ID запроса", async () => {
    await withCliFixture(async (fixture) => {
      const response = await fixture.invoke(["git-sync", "now", "--wait-ms", "1"], {
        gitSync: operationPort(async () => {
          throw new RelayError("GIT_SYNC_WAIT_TIMEOUT", "Запрос принят", 4, {
            requestId: "accepted-id",
            state: "running",
          });
        }),
      });

      expect(response).toMatchObject({ code: 4, stdout: "" });
      expect(response.stderr).toContain("ID запроса: accepted-id");
    }, group);
  });

  test("workspace refresh применяет wait budget независимо и сохраняет requestId ошибочной регистрации", async () => {
    await withCliFixture(async (fixture) => {
      writeFileSync(
        join(fixture.runtime.cwd, "relay.workspace.json"),
        JSON.stringify({
          version: 1,
          projects: [
            { name: "slow", path: "slow" },
            { name: "ready", path: "ready" },
          ],
        }),
      );
      const calls: GitSyncRequest[] = [];
      const port = operationPort(async (request) => {
        calls.push(request);
        if (request.options.config === join(fixture.runtime.cwd, "slow", "relay.config.json")) {
          throw new RelayError("GIT_SYNC_WAIT_TIMEOUT", "Ожидание", 4, {
            requestId: "slow-id",
            state: "running",
          });
        }
        return { requestId: "ready-id", phase: "idle" };
      });

      const response = await fixture.invoke(
        ["git-sync", "status", "--refresh", "--all", "--wait-ms", "5", "--format", "json"],
        { gitSync: port },
      );

      expect(response.code).toBe(4);
      expect(calls.map((request) => request.input)).toEqual([
        { refresh: true, waitMs: 5 },
        { refresh: true, waitMs: 5 },
      ]);
      expect(JSON.parse(response.stdout)).toMatchObject({
        ok: false,
        data: {
          items: [
            {
              name: "slow",
              ok: false,
              error: { details: { requestId: "slow-id", state: "running" } },
            },
            { name: "ready", ok: true, data: { requestId: "ready-id" } },
          ],
        },
      });
    }, group);
  });

  test.each([
    { name: "wait без refresh", args: ["status", "--wait-ms", "5"] },
    { name: "request-id без refresh", args: ["status", "--request-id", "old-id"] },
    {
      name: "один request-id для всех проектов",
      args: ["status", "--refresh", "--all", "--request-id", "old-id"],
    },
    { name: "нулевое ожидание", args: ["now", "--wait-ms", "0"] },
    { name: "превышение wait budget", args: ["now", "--wait-ms", "90001"] },
    { name: "пустой ID", args: ["now", "--request-id", ""] },
  ])("$name отклоняется до port", async ({ args }) => {
    await withCliFixture(async (fixture) => {
      let calls = 0;
      const error = await fixture.error(["git-sync", ...args], 2, {
        gitSync: operationPort(async () => {
          calls++;
          return null;
        }),
      });

      expect(error.code).toBe("INVALID_ARGUMENT");
      expect(calls).toBe(0);
    }, group);
  });

  test("help request и now объясняет unknown/timeout без проекта или stdin", async () => {
    const query = await invokeIsolatedCli(["git-sync", "request", "get", "--help"]);
    const wait = await invokeIsolatedCli([
      "git-sync",
      "now",
      "--request-id",
      "old-id",
      "--wait-ms",
      "90000",
      "--help",
    ]);

    expect(query).toMatchObject({ exitCode: 0, stderr: "" });
    expect(query.stdout).toContain("unknown");
    expect(query.stdout).toContain("15 минут");
    expect(query.stdout).toContain("успех самой операции обозначает только completed");
    expect(wait).toMatchObject({ exitCode: 0, stderr: "" });
    expect(wait.stdout).toContain("GIT_SYNC_WAIT_TIMEOUT");
    expect(wait.stdout).toContain("GIT_SYNC_OUTCOME_UNKNOWN");
    expect(wait.stdout).toContain("не отправляет новую операцию");
  });
});
