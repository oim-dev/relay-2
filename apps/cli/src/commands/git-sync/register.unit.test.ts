import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { RelayError, type GitSyncRequest } from "@relay/contracts";
import type { GitSyncClient, GitSyncServiceStatus } from "@relay/project-runtime";
import { withCliFixture } from "../../../tests/integration/helpers/cli-fixture";
import { commandRoutes, helpRuntime, invokeIsolatedCli } from "../../../tests/helpers/help";
import { createProgram } from "../../app/program";
import { readResolutionInput } from "./input";

const group = "git-sync-implementation/cli-runtime";
const actions = [
  {
    argv: ["connect", "--remote", "../remote с пробелом", "--branch", "data-v2"],
    action: "connect",
    input: { remote: "../remote с пробелом", branch: "data-v2" },
  },
  { argv: ["now"], action: "now" },
  { argv: ["auto", "enable"], action: "auto.enable" },
  { argv: ["auto", "disable"], action: "auto.disable" },
  { argv: ["worker", "start"], action: "worker.start" },
  { argv: ["worker", "stop"], action: "worker.stop" },
  { argv: ["worker", "restart"], action: "worker.restart" },
  { argv: ["conflicts", "list"], action: "conflicts.list" },
  {
    argv: ["conflicts", "get", "conflict-1"],
    action: "conflicts.get",
    input: { id: "conflict-1" },
  },
  {
    argv: ["restore", "--remote", "https://example.org/team.git"],
    action: "restore",
    input: { remote: "https://example.org/team.git" },
  },
] as const;

const processFailures = [
  {
    name: "сетевой отказ",
    code: "REMOTE_OFFLINE",
    message: "Нет сети",
    exitCode: 7,
    details: { remote: "origin" },
  },
  {
    name: "неразрешённый конфликт",
    code: "SYNC_CONFLICT",
    message: "Остались неразрешённые конфликты",
    exitCode: 4,
    details: {
      status: { conflicts: { count: 1 }, pending: { changesets: 1 } },
      conflicts: [{ id: "change-1", fingerprint: "read-fingerprint", code: "TEXT_CONFLICT" }],
    },
  },
] as const;

/**
 * Подменяет только процессный порт; попадание в незаявленную службу/foreground является отказом теста.
 */
function requestClient(request: GitSyncClient["request"]): GitSyncClient {
  return {
    request,
    /**
     * Запрещает незаявленный доступ к native manager.
     */
    service: async (): Promise<never> => {
      throw new Error("Неожиданный native manager");
    },
    /**
     * Запрещает незаявленный запуск supervisor.
     */
    supervise: async (): Promise<never> => {
      throw new Error("Неожиданный foreground");
    },
  };
}

describe("Пользовательский вход relay git-sync", () => {
  test("SUPERVISOR_REQUIRED проходит без скрытого fallback установки службы", async () => {
    await withCliFixture(async (cli) => {
      const calls: GitSyncRequest[] = [];
      const details = {
        home: cli.root,
        commands: ["relay git-sync service enable", "relay git-sync supervise"],
      };
      const failure = await cli.error(["git-sync", "auto", "enable"], 4, {
        gitSync: requestClient(async (request) => {
          calls.push(request);
          throw new RelayError("SUPERVISOR_REQUIRED", "Сначала запустите supervisor", 4, details);
        }),
      });

      expect(failure).toMatchObject({ code: "SUPERVISOR_REQUIRED", details });
      expect(calls.map((request) => request.action)).toEqual(["auto.enable"]);
    }, group);
  });

  test("лимит пользовательского --input остаётся 8 MiB независимо от wire-limit 16 MiB", async () => {
    const input = JSON.stringify({ text: "x".repeat(8 * 1024 * 1024) });

    await expect(
      readResolutionInput({ input }, { cwd: "/missing", env: {}, stdin: "" }),
    ).rejects.toMatchObject({ code: "INPUT_TOO_LARGE", exitCode: 2 });
  });

  test.each(["inline", "file", "stdin"] as const)(
    "JSON 1e999 из %s отклоняется до процессного порта",
    async (source) => {
      await withCliFixture(async (cli) => {
        const text = '{"choice":"local","fingerprint":"fingerprint","value":1e999}';
        writeFileSync(join(cli.runtime.cwd, "non-finite.json"), text);
        const input = { inline: text, file: "@non-finite.json", stdin: "-" }[source];
        let calls = 0;

        const answer = await cli.invoke(
          ["git-sync", "conflicts", "resolve", "conflict-id", "--input", input, "--format", "json"],
          {
            stdin: text,
            gitSync: requestClient(async () => {
              calls++;
              return null;
            }),
          },
        );

        expect(answer).toMatchObject({ code: 2, stdout: "" });
        expect(JSON.parse(answer.stderr).error).toMatchObject({
          code: "GIT_SYNC_INVALID_REQUEST",
          details: { path: ["value"], reason: "non-finite-number" },
          helpCommand: "relay git-sync conflicts resolve --help",
        });
        expect(calls).toBe(0);
      }, group);
    },
  );

  test.each(actions)(
    "$action передаёт точный процессный запрос без открытия проектной БД",
    async ({ argv, action, ...rest }) => {
      await withCliFixture(async (cli) => {
        const calls: GitSyncRequest[] = [];
        const gitSync = requestClient(async (request) => {
          calls.push(request);
          await Promise.resolve();
          return { action: request.action };
        });

        const answer = await cli.success(
          ["git-sync", ...argv, "--config", "missing.json", "--project", "commerce"],
          { gitSync },
        );

        expect(answer.data).toEqual({ action });
        expect(calls).toEqual([
          {
            version: 1,
            action,
            options: {
              cwd: cli.runtime.cwd,
              ...(cli.runtime.env.RELAY_HOME !== undefined
                ? { home: cli.runtime.env.RELAY_HOME }
                : {}),
              config: "missing.json",
              project: "commerce",
            },
            ...("input" in rest ? { input: rest.input } : {}),
          },
        ]);
      }, group);
    },
  );

  test.each(["inline", "file", "stdin"] as const)(
    "resolve читает %s, сохраняет решение и приоритет --actor",
    async (source) => {
      await withCliFixture(async (cli) => {
        const resolution = {
          version: 1,
          expectedGeneration: 7,
          body: "  первая\n\nвторая  ",
          enabled: false,
        };
        writeFileSync(join(cli.runtime.cwd, "решение.json"), JSON.stringify(resolution));
        const input = { inline: JSON.stringify(resolution), file: "@решение.json", stdin: "-" }[
          source
        ];
        const calls: GitSyncRequest[] = [];
        let reads = 0;

        await cli.success(
          [
            "git-sync",
            "conflicts",
            "resolve",
            "conflict-1",
            "--input",
            input,
            "--actor",
            " human ",
          ],
          {
            gitSync: requestClient(async (request) => {
              calls.push(request);
              return { resolved: true };
            }),
            stdin: (): string => {
              reads++;
              return JSON.stringify(resolution);
            },
          },
        );

        expect(calls[0]?.input).toEqual({
          id: "conflict-1",
          decision: resolution,
          actor: " human ",
        });
        expect(reads).toBe(source === "stdin" ? 1 : 0);
      }, group);
    },
  );

  test("неверный JSON отклоняется до процесса, отсутствие автора не подставляет system", async () => {
    await withCliFixture(async (cli) => {
      const calls: GitSyncRequest[] = [];
      const gitSync = requestClient(async (request) => {
        calls.push(request);
        return {};
      });

      const invalid = await cli.error(
        ["git-sync", "conflicts", "resolve", "id", "--input", "[1]"],
        2,
        { gitSync },
      );
      const missingActor = await cli.error(
        ["git-sync", "conflicts", "resolve", "id", "--input", "{}"],
        2,
        { gitSync, env: {} },
      );

      expect(invalid.code).toBe("INVALID_JSON");
      expect(missingActor.code).toBe("ACTOR_REQUIRED");
      expect(calls).toEqual([]);
    }, group);
  });

  test.each(processFailures)(
    "now: $name сохраняет code, exitCode и details без повторной попытки",
    async ({ code, message, exitCode, details }) => {
      await withCliFixture(async (cli) => {
        let calls = 0;

        const failure = await cli.error(["git-sync", "now"], exitCode, {
          gitSync: requestClient(async () => {
            calls++;
            await Promise.resolve();
            throw new RelayError(code, message, exitCode, details);
          }),
        });

        expect(failure).toEqual({ code, message, details });
        expect(calls).toBe(1);
      }, group);
    },
  );

  test("workspace status возвращает недоступную регистрацию и последующие проекты в text/JSON", async () => {
    await withCliFixture(async (cli) => {
      writeFileSync(
        join(cli.runtime.cwd, "relay.workspace.json"),
        JSON.stringify({
          version: 1,
          projects: [
            { name: "offline", path: "missing" },
            { name: "commerce", path: "commerce" },
          ],
        }),
      );
      mkdirSync(join(cli.runtime.cwd, "commerce"));
      const calls: GitSyncRequest[] = [];
      const status = {
        projectId: "commerce-id",
        worker: { actual: "stopped", responsive: false },
        phase: "idle",
        git: { ahead: null, behind: 2 },
        pending: { changesets: 3, unexported: null },
      };
      const gitSync = requestClient(async (request) => {
        calls.push(request);
        if (request.options.config?.includes("missing")) {
          throw new RelayError("DATABASE_NOT_FOUND", "Нет базы", 3);
        }
        return status;
      });

      const json = await cli.invoke(["git-sync", "status", "--refresh", "--format", "json"], {
        gitSync,
      });
      const text = await cli.invoke(["git-sync", "status", "--all"], { gitSync });

      expect(json.code).toBe(3);
      expect(JSON.parse(json.stdout)).toMatchObject({
        ok: false,
        data: {
          scope: "workspace",
          items: [
            { name: "offline", ok: false, error: { code: "DATABASE_NOT_FOUND" } },
            { name: "commerce", ok: true, data: status },
          ],
        },
      });
      expect(JSON.parse(json.stderr).error.code).toBe("DATABASE_NOT_FOUND");
      expect(calls.slice(0, 2).map((request) => request.input)).toEqual([
        { refresh: true },
        { refresh: true },
      ]);
      expect(text.code).toBe(3);
      expect(text.stdout).toContain("offline");
      expect(text.stdout).toContain("commerce");
      expect(text.stdout).toContain("Процесс worker:");
      expect(text.stdout).toContain("Синхронизация:");
      expect(text.stdout).toContain("Исходящие Git-коммиты: неизвестно");
      expect(text.stdout).toContain("Входящие Git-коммиты: 2");
    }, group);
  });

  test("--all вместе с --project отклоняется до процесса", async () => {
    await withCliFixture(async (cli) => {
      const error = await cli.error(["git-sync", "status", "--all", "--project", "commerce"], 2, {
        gitSync: requestClient(async (): Promise<never> => {
          throw new Error("Процесс не нужен");
        }),
      });
      expect(error.code).toBe("INVALID_ARGUMENT");
    }, group);
  });

  test("одиночный status сохраняет форму items и успех при конфликтах, без refresh по умолчанию", async () => {
    await withCliFixture(async (cli) => {
      const calls: GitSyncRequest[] = [];
      const data = {
        worker: { actual: "stopped", responsive: false },
        git: { ahead: null, behind: null },
        pending: { changesets: 1, unexported: 1 },
        conflicts: { count: 1 },
      };
      const answer = await cli.success(["git-sync", "status"], {
        gitSync: requestClient(async (request) => {
          calls.push(request);
          return data;
        }),
      });

      expect(answer.data).toEqual({
        version: 1,
        scope: "project",
        items: [{ name: null, path: null, ok: true, data }],
      });
      expect(calls).toHaveLength(1);
      expect(calls[0]?.action).toBe("status");
      expect(calls[0]?.input).toEqual({ refresh: false });
    }, group);
  });

  test("отказ одиночного status сохраняет проект в data.items и исходный exit code", async () => {
    await withCliFixture(async (cli) => {
      const error = {
        code: "DATABASE_NOT_FOUND",
        message: "База выбранного проекта недоступна",
        exitCode: 3,
        details: { databasePath: "missing.sqlite" },
      };
      const gitSync = requestClient(async () => {
        await Promise.resolve();
        throw new RelayError(error.code, error.message, error.exitCode, error.details);
      });

      const answer = await cli.invoke(
        ["git-sync", "status", "--project", "offline", "--format", "json"],
        { gitSync },
      );

      expect(answer.code).toBe(3);
      expect(answer.stdout).not.toBe("");
      expect(JSON.parse(answer.stdout)).toEqual({
        ok: false,
        data: {
          version: 1,
          scope: "project",
          items: [{ name: "offline", path: null, ok: false, error }],
        },
        error: { code: error.code, message: error.message, details: error.details },
      });
      expect(JSON.parse(answer.stderr)).toEqual({
        ok: false,
        error: { code: error.code, message: error.message, details: error.details },
      });
    }, group);
  });

  test.each(["enable", "disable", "status"] as const)(
    "service %s вызывает только Runtime lifecycle",
    async (action) => {
      await withCliFixture(async (cli) => {
        const calls: unknown[] = [];
        const gitSync = {
          ...requestClient(async (): Promise<never> => {
            throw new Error("Служба не обращается к проектной БД");
          }),
          /**
           * Сохраняет явные service action/home вместо native manager.
           */
          service: async (
            selected: "enable" | "disable" | "status",
            options: { cwd: string; home?: string },
          ): Promise<GitSyncServiceStatus> => {
            calls.push({ selected, options });
            return {
              platform: "linux" as const,
              id: "relay-fixture",
              configPath: "/fixture/service",
              home: "/fixture/home",
              installed: action !== "disable",
              desiredRegistration:
                action === "disable" ? ("disabled" as const) : ("enabled" as const),
              registered: action !== "disable",
              enabled: action !== "disable",
              state: "stopped" as const,
              startup: "login",
              managerExitCode: 0,
              supervisor: {
                actual: "stopped" as const,
                responsive: false,
                instance: null,
                release: null,
                pid: null,
                heartbeat: null,
              },
            };
          },
        };

        await cli.success(["git-sync", "service", action], { gitSync });

        expect(calls).toEqual([
          { selected: action, options: { cwd: cli.runtime.cwd, home: cli.runtime.env.RELAY_HOME } },
        ]);
      }, group);
    },
  );

  test("foreground ожидает асинхронное завершение и не добавляет JSON envelope к потокам", async () => {
    await withCliFixture(async (cli) => {
      let completed = false;
      const gitSync = {
        ...requestClient(async () => null),
        /**
         * Имитирует только foreground-порт; async граница должна дождаться результата.
         */
        supervise: async (options: { home?: string }): Promise<number> => {
          expect(options.home).toBe("other home");
          await Promise.resolve();
          completed = true;
          return 0;
        },
      };

      const answer = await cli.invoke(
        ["git-sync", "supervise", "--home", "other home", "--format", "json"],
        { gitSync },
      );

      expect(answer).toEqual({ code: 0, stdout: "", stderr: "" });
      expect(completed).toBe(true);
    }, group);
  });

  test("все новые help/version автономны, включая --input -", async () => {
    const routes = commandRoutes(createProgram(helpRuntime).options.subCommands).filter(
      (route) => route.argv[0] === "git-sync",
    );
    for (const route of routes) {
      const response = await invokeIsolatedCli([...route.argv, "--help"]);
      expect(response.exitCode).toBe(0);
      expect(response.stderr).toBe("");
      expect(response.stdout).toContain("ПРИМЕРЫ:");
    }
    expect(
      await invokeIsolatedCli([
        "git-sync",
        "conflicts",
        "resolve",
        "id",
        "--input",
        "-",
        "--version",
      ]),
    ).toMatchObject({ exitCode: 0, stderr: "" });
  });
});
