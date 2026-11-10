import { describe, expect, test } from "bun:test";
import { realpathSync } from "node:fs";
import { createGitSyncClient } from "./client";
import type { ProcessCommand, ProcessResult } from "./process.types";

const deadlines = [
  { name: "обычный default", action: "status", timeoutMs: undefined, expected: 120_000 },
  { name: "короткий заданный запрос", action: "status", timeoutMs: 500, expected: 500 },
  { name: "auto default", action: "auto", timeoutMs: undefined, expected: 10_000 },
  { name: "короткий заданный auto", action: "auto", timeoutMs: 500, expected: 500 },
  {
    name: "auto ограничен при длинном deadline",
    action: "auto",
    timeoutMs: 120_000,
    expected: 10_000,
  },
] as const;

describe("Request-порт совместимой CLI", () => {
  test("ленивая фабрика проверяет CLI один раз и передаёт raw envelope без daemon или stream входов", async () => {
    const calls: ProcessCommand[] = [];
    const signal = new AbortController().signal;
    const env = { HOME: "/fixture/home", RELAY_TEST_VALUE: "Точная среда" };
    const client = createGitSyncClient({
      cwd: import.meta.dir,
      env,
      binary: process.execPath,
      executablePath: process.execPath,
      userHome: "/fixture/home",
      version: "port-release",
      signal,
      /**
       * Подменяет только subprocess; исполненный argv и JSON остаются проверяемой границей клиента.
       */
      async runner(command): Promise<ProcessResult> {
        calls.push(command);
        return command.args[0] === "--version"
          ? { exitCode: 0, stdout: "relay port-release\n", stderr: "" }
          : {
              exitCode: 0,
              stdout: JSON.stringify({
                version: 1,
                ok: true,
                data: JSON.parse(command.input ?? "null"),
              }),
              stderr: "",
            };
      },
    });
    const request = {
      version: 1 as const,
      action: "status",
      options: { cwd: "/selected/project", config: "project.json" },
      input: { refresh: false, value: "  Текст\r\n", empty: "", zero: 0, absent: null },
    };
    expect(calls).toEqual([]);
    expect(Object.keys(client)).toEqual(["request"]);

    const first = await client.request(request);
    const second = await client.request(request);

    expect(first).toEqual(request);
    expect(second).toEqual(request);
    expect(calls.map((command) => command.args)).toEqual([
      ["--version"],
      ["--git-sync-request"],
      ["--git-sync-request"],
    ]);
    expect(calls[1]).toEqual({
      executable: realpathSync(process.execPath),
      args: ["--git-sync-request"],
      cwd: import.meta.dir,
      env,
      input: expect.any(String),
      strictStdout: true,
      timeoutMs: 120_000,
      signal,
    });
  });

  test("ошибка version probe не блокирует новое явное обращение после установки совместимой CLI", async () => {
    let compatible = false;
    const calls: string[][] = [];
    const client = createGitSyncClient({
      cwd: import.meta.dir,
      env: {},
      binary: process.execPath,
      executablePath: process.execPath,
      userHome: "/fixture",
      version: "0.0.0",
      /**
       * Между явными запросами меняется только наблюдаемый выпуск; автоматический повтор запрещён.
       */
      async runner(command): Promise<ProcessResult> {
        calls.push([...command.args]);
        if (command.args[0] === "--version") {
          return { exitCode: 0, stdout: compatible ? "relay 0.0.0" : "relay 9.0.0", stderr: "" };
        }
        return {
          exitCode: 0,
          stdout: '{"version":1,"ok":true,"data":{"connected":false}}',
          stderr: "",
        };
      },
    });
    const request = { version: 1 as const, action: "status", options: { cwd: "/fixture" } };

    await expect(client.request(request)).rejects.toMatchObject({
      code: "GIT_SYNC_VERSION_MISMATCH",
    });

    expect(calls).toEqual([["--version"]]);
    compatible = true;

    const result = await client.request(request);

    expect(result).toEqual({ connected: false });
    expect(calls).toEqual([["--version"], ["--version"], ["--git-sync-request"]]);
  });

  test.each(deadlines)(
    "$name сохраняет deadline запроса CLI",
    async ({ action, timeoutMs, expected }) => {
      const calls: ProcessCommand[] = [];
      const client = createGitSyncClient({
        cwd: import.meta.dir,
        env: {},
        binary: process.execPath,
        executablePath: process.execPath,
        userHome: "/fixture",
        version: "0.0.0",
        ...(timeoutMs === undefined ? {} : { timeoutMs }),
        /**
         * Не ждёт реальный deadline: его соблюдение принадлежит production guardian integration.
         */
        async runner(command): Promise<ProcessResult> {
          calls.push(command);
          return {
            exitCode: 0,
            stdout:
              command.args[0] === "--version"
                ? "relay 0.0.0"
                : '{"version":1,"ok":true,"data":null}',
            stderr: "",
          };
        },
      });

      const result = await client.request({ version: 1, action, options: { cwd: "/fixture" } });

      expect(result).toBeNull();
      expect(calls).toHaveLength(2);
      expect(calls[1]).toMatchObject({ args: ["--git-sync-request"], timeoutMs: expected });
    },
  );
});
