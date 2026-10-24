import { describe, expect, test } from "bun:test";
import { RelayError, type GitSyncRequest } from "@relay/contracts";
import { createGitSyncClient } from "./client";
import type { GitSyncEnvironment } from "./client.types";
import type { ProcessRunner } from "./process.types";

const environment = {
  cwd: process.cwd(),
  env: {},
  binary: process.execPath,
  executablePath: process.execPath,
  version: "0.0.0",
  userHome: process.cwd(),
} satisfies GitSyncEnvironment;

/**
 * Подставляет только native boundary; version probe успешен, request проверяется вызывающим тестом.
 */
function requestRunner(run: ProcessRunner): ProcessRunner {
  return async (command) =>
    command.args[0] === "--version" ? { exitCode: 0, stdout: "0.0.0\n", stderr: "" } : run(command);
}

/**
 * Извлекает диагностируемый RelayError; успешный исход не подменяется отрицательным assertion.
 */
async function rejectedRequest(operation: Promise<unknown>): Promise<RelayError> {
  try {
    await operation;
  } catch (error) {
    if (!(error instanceof RelayError)) {
      throw error;
    }
    return error;
  }
  throw new Error("Ожидался отказ process request");
}

describe("Correlation process request Git Sync", () => {
  test("ID нового now попадает в wire и process-timeout error без изменения входа", async () => {
    const original: GitSyncRequest = {
      version: 1,
      action: "now",
      options: { cwd: environment.cwd },
      input: { waitMs: 7 },
    };
    const sent: GitSyncRequest[] = [];
    const cause = new RelayError("GIT_SYNC_TIMEOUT", "Process deadline", 124, {
      stage: "running",
      stderr: "slow request",
    });
    const client = createGitSyncClient({
      ...environment,
      runner: requestRunner(async (command) => {
        sent.push(JSON.parse(command.input ?? "null"));
        throw cause;
      }),
    });

    const error = await rejectedRequest(client.request(original));

    expect(sent).toHaveLength(1);
    const id = sent[0]?.input?.operationId;
    expect(typeof id).toBe("string");
    expect(String(id).length).toBeGreaterThan(0);
    expect(sent[0]).toMatchObject({
      version: 1,
      action: "now",
      input: { waitMs: 7, operationId: id },
    });
    expect(error).toMatchObject({
      code: "GIT_SYNC_TIMEOUT",
      exitCode: 124,
      details: {
        requestId: id,
        operationId: id,
        state: "unknown",
        stage: "running",
        stderr: "slow request",
      },
    });
    expect(error.cause).toBe(cause);
    expect(original.input).toEqual({ waitMs: 7 });
  });

  test("ID назначен до первого запуска компонента, включая version probe", async () => {
    const calls: string[][] = [];
    const client = createGitSyncClient({
      ...environment,
      runner: async (command) => {
        calls.push([...command.args]);
        throw new RelayError("GIT_SYNC_TIMEOUT", "Probe deadline", 124);
      },
    });

    const error = await rejectedRequest(
      client.request({ version: 1, action: "now", options: { cwd: environment.cwd } }),
    );

    expect(calls).toEqual([["--version"]]);
    expect(typeof error.details?.requestId).toBe("string");
    expect(error.details?.operationId).toBe(error.details?.requestId);
    expect(error.details?.state).toBe("unknown");
  });

  test.each([
    { action: "now", input: { requestId: "known-id", waitMs: 12 } },
    { action: "status", input: { refresh: true, requestId: "known-id", waitMs: 12 } },
    { action: "request.get", input: { requestId: "known-id" } },
  ])("$action с requestId не становится новым submit при timeout", async ({ action, input }) => {
    const sent: GitSyncRequest[] = [];
    const client = createGitSyncClient({
      ...environment,
      runner: requestRunner(async (command) => {
        sent.push(JSON.parse(command.input ?? "null"));
        throw new RelayError("GIT_SYNC_TIMEOUT", "Process deadline", 124);
      }),
    });

    const error = await rejectedRequest(
      client.request({ version: 1, action, options: { cwd: environment.cwd }, input }),
    );

    expect(sent).toHaveLength(1);
    expect(sent[0]?.input).toEqual(input);
    expect(error.details).toEqual({ requestId: "known-id", state: "unknown" });
  });

  test.each([
    { code: "GIT_SYNC_WAIT_TIMEOUT", state: "running" },
    { code: "GIT_SYNC_OUTCOME_UNKNOWN", state: "unknown" },
    { code: "GIT_SYNC_PROTOCOL_ERROR", state: "failed" },
  ])("$code сохраняет достоверные details компонента", async ({ code, state }) => {
    const details = {
      requestId: "accepted-id",
      instance: "worker-instance",
      state,
      query: ["relay", "git-sync", "request", "get", "accepted-id"],
    };
    let calls = 0;
    const client = createGitSyncClient({
      ...environment,
      runner: requestRunner(async () => {
        calls++;
        return {
          exitCode: 4,
          stderr: "",
          stdout: JSON.stringify({
            version: 1,
            ok: false,
            error: { code, message: "Исход ожидания", exitCode: 4, details },
          }),
        };
      }),
    });

    const error = await rejectedRequest(
      client.request({
        version: 1,
        action: "now",
        options: { cwd: environment.cwd },
        input: { requestId: "accepted-id" },
      }),
    );

    expect(error.code).toBe(code);
    expect(error.exitCode).toBe(4);
    expect(error.details).toEqual(details);
    expect(calls).toBe(1);
  });

  test("новые now/refresh получают разные IDs; cached status и explicit operationId сохраняются", async () => {
    const sent: GitSyncRequest[] = [];
    const client = createGitSyncClient({
      ...environment,
      runner: requestRunner(async (command) => {
        const request: GitSyncRequest = JSON.parse(command.input ?? "null");
        sent.push(request);
        return {
          exitCode: 0,
          stderr: "",
          stdout: JSON.stringify({ version: 1, ok: true, data: { received: true } }),
        };
      }),
    });
    const requests: readonly Pick<GitSyncRequest, "action" | "input">[] = [
      { action: "now" },
      { action: "now" },
      { action: "status", input: { refresh: true } },
      { action: "status", input: { refresh: false } },
      { action: "now", input: { operationId: "caller-chosen-id" } },
    ];
    for (const request of requests) {
      await client.request({ version: 1, options: { cwd: environment.cwd }, ...request });
    }

    const ids = sent.slice(0, 3).map((request) => request.input?.operationId);
    expect(ids.every((id) => typeof id === "string" && id.length > 0)).toBe(true);
    expect(new Set(ids).size).toBe(3);
    expect(sent[3]?.input).toEqual({ refresh: false });
    expect(sent[4]?.input).toEqual({ operationId: "caller-chosen-id" });
  });

  test("двойной ID отклоняется до version probe", async () => {
    let calls = 0;
    const client = createGitSyncClient({
      ...environment,
      runner: async (): Promise<never> => {
        calls++;
        throw new Error("Не должно быть spawn");
      },
    });

    const error = await rejectedRequest(
      client.request({
        version: 1,
        action: "now",
        options: { cwd: environment.cwd },
        input: { requestId: "old-id", operationId: "new-id" },
      }),
    );

    expect(error.code).toBe("INVALID_ARGUMENT");
    expect(calls).toBe(0);
  });

  test("нечитаемый ответ после submit сохраняет заранее переданный ID как unknown", async () => {
    let calls = 0;
    const client = createGitSyncClient({
      ...environment,
      runner: requestRunner(async () => {
        calls++;
        return { exitCode: 0, stdout: "broken-json", stderr: "diagnostic" };
      }),
    });

    const error = await rejectedRequest(
      client.request({
        version: 1,
        action: "now",
        options: { cwd: environment.cwd },
        input: { operationId: "chosen-id" },
      }),
    );

    expect(error).toMatchObject({
      code: "GIT_SYNC_PROTOCOL_ERROR",
      exitCode: 1,
      details: {
        requestId: "chosen-id",
        operationId: "chosen-id",
        state: "unknown",
        stderr: "diagnostic",
      },
    });
    expect(calls).toBe(1);
  });

  test("прерывание process wait не объявляет принятую операцию cancelled", async () => {
    const client = createGitSyncClient({
      ...environment,
      runner: requestRunner(async () => {
        throw new RelayError("GIT_SYNC_CANCELLED", "Запуск отменён", 130, { stage: "running" });
      }),
    });

    const error = await rejectedRequest(
      client.request({
        version: 1,
        action: "now",
        options: { cwd: environment.cwd },
        input: { requestId: "accepted-id" },
      }),
    );

    expect(error).toMatchObject({
      code: "GIT_SYNC_CANCELLED",
      exitCode: 130,
      details: { requestId: "accepted-id", state: "unknown", stage: "running" },
    });
    expect(error.message).toContain("Ожидание ответа компонента прервано");
    expect(error.message).toContain("Исход операции неизвестен");
  });
});
