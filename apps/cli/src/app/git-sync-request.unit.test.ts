import { describe, expect, test } from "bun:test";
import { GIT_SYNC_REQUEST_MAX_BYTES, RelayError, type GitSyncRequest } from "@relay/contracts";
import type { GitSyncClient } from "@relay/project-runtime";
import { requestClient } from "../../tests/helpers/git-sync-client";
import type { CliInvocation } from "../../tests/integration/helpers/cli-fixture.types";
import type { CliRuntime } from "../execution/runtime.types";
import { runGitSyncRequest } from "./git-sync-request";

const requests = [
  { name: "автоматический обмен", action: "auto" },
  {
    name: "ожидание прежнего запроса",
    action: "now",
    input: { requestId: "исходный-id", waitMs: 1234 },
  },
  {
    name: "решение конфликта",
    action: "conflicts.resolve",
    input: {
      id: "change-id",
      actor: "Автор",
      decision: { choice: "custom", body: "  Текст\n\n", enabled: false },
    },
  },
] as const;
const invalidRequests = [
  { name: "повреждённый JSON", source: "{", code: "GIT_SYNC_INVALID_REQUEST" },
  {
    name: "чужая версия wire",
    source: '{"version":2,"action":"auto","options":{"cwd":"/project"}}',
    code: "GIT_SYNC_PROTOCOL_VERSION",
  },
] as const;

/**
 * Вызывает private wire-вход с изолированными потоками и подменой только backend-порта.
 * Каталог намеренно отсутствует: вход не должен открывать БД или рекурсивно выполнять auto.
 */
async function invokeRequest(
  stdin: CliRuntime["stdin"],
  request: GitSyncClient["request"],
): Promise<CliInvocation> {
  let stdout = "";
  let stderr = "";
  const code = await runGitSyncRequest(
    { cwd: "/missing-server-cwd", env: {}, stdin, gitSync: requestClient(request) },
    {
      /**
       * Сохраняет весь wire-ответ, включая лишние envelopes и переводы строк.
       */
      stdout: (text): void => {
        stdout += text;
      },
      /**
       * Позволяет отличить wire-ошибку от случайной пользовательской диагностики CLI.
       */
      stderr: (text): void => {
        stderr += text;
      },
    },
  );
  return { code, stdout, stderr };
}

describe("Общий Server → CLI wire-вход синхронизации", () => {
  test.each(requests)(
    "$name сохраняет options/input и вызывает backend ровно один раз",
    async ({ name: _name, ...action }) => {
      const request = {
        version: 1,
        ...action,
        options: {
          cwd: "/проект с пробелом",
          config: "../workspace.json",
          home: "../дом",
          project: "commerce",
        },
      } satisfies GitSyncRequest;
      const calls: GitSyncRequest[] = [];
      const budgets: (number | undefined)[] = [];
      const data = { requestId: "исходный-id", state: "unknown", remoteHead: null };

      const response = await invokeRequest(
        (maxBytes) => {
          budgets.push(maxBytes);
          return Promise.resolve(JSON.stringify(request));
        },
        async (value) => {
          calls.push(value);
          return data;
        },
      );

      expect(response).toMatchObject({ code: 0, stderr: "" });
      expect(JSON.parse(response.stdout)).toEqual({ version: 1, ok: true, data });
      expect(response.stdout.trim().split("\n")).toHaveLength(1);
      expect(calls).toEqual([request]);
      expect(budgets).toEqual([GIT_SYNC_REQUEST_MAX_BYTES]);
    },
  );

  test("timeout backend сохраняет requestId/code/exitCode/details в wire без retry или warning", async () => {
    const request: GitSyncRequest = {
      version: 1,
      action: "now",
      options: { cwd: "/project" },
      input: { requestId: "held", waitMs: 7 },
    };
    const failure = {
      code: "GIT_SYNC_WAIT_TIMEOUT",
      message: "Ожидание завершено",
      exitCode: 4,
      details: { requestId: "held", state: "running", instance: "worker" },
    };
    const calls: GitSyncRequest[] = [];

    const response = await invokeRequest(JSON.stringify(request), async (value) => {
      calls.push(value);
      throw new RelayError(failure.code, failure.message, failure.exitCode, failure.details);
    });

    expect(response).toMatchObject({ code: 4, stderr: "" });
    expect(JSON.parse(response.stdout)).toEqual({ version: 1, ok: false, error: failure });
    expect(response.stdout.trim().split("\n")).toHaveLength(1);
    expect(calls).toEqual([request]);
  });

  test.each(invalidRequests)(
    "$name отклоняется совместимым envelope до backend",
    async ({ source, code }) => {
      const calls: GitSyncRequest[] = [];

      const response = await invokeRequest(source, async (request) => {
        calls.push(request);
        return null;
      });

      expect(response).toMatchObject({ code: 2, stderr: "" });
      expect(JSON.parse(response.stdout)).toMatchObject({
        version: 1,
        ok: false,
        error: { code, exitCode: 2 },
      });
      expect(calls).toEqual([]);
    },
  );
});
