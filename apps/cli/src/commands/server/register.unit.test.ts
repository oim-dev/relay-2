import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import {
  createServerClient,
  type RuntimeOptions,
  type ServerStartInput,
} from "@relay/project-runtime";
import type { ServerInstanceStatus } from "@relay/contracts";
import { withCliFixture } from "../../../tests/integration/helpers/cli-fixture";
import { invokeIsolatedCli } from "../../../tests/helpers/help";

const observed: ServerInstanceStatus = {
  instanceId: "00000000-0000-0000-0000-000000000001",
  bootId: "00000000-0000-0000-0000-000000000002",
  state: "ready",
  pid: 42,
  url: "http://127.0.0.1:8080/",
  version: "test",
  mode: "service",
  scope: { kind: "workspace", configPath: "/workspace/relay.workspace.json", project: null },
  projects: [],
  startedAt: "2026-10-25T00:00:00.000Z",
};

describe("Пользовательский вход relay server", () => {
  test("пустой list работает без проекта и binary и не создаёт RELAY_HOME", async () => {
    await withCliFixture(async (cli) => {
      const home = String(cli.runtime.env.RELAY_HOME);

      const response = await cli.success(["server", "list", "--config", "missing.json"]);

      expect(response.data).toEqual({ version: 1, home, running: 0, registered: 0, items: [] });
      expect(existsSync(home)).toBe(false);
    }, "server-web/lifecycle/unit-fixtures");
  });
  test.each(["start", "run", "list", "status", "stop", "restart", "open"])(
    "%s help и version доступны без проекта, binary и stdin",
    async (action) => {
      const help = await invokeIsolatedCli(["server", action, "--help"]);
      const version = await invokeIsolatedCli(["server", action, "--version"]);

      expect(help.exitCode).toBe(0);
      expect(help.stderr).toBe("");
      expect(help.stdout).toContain("ПРИМЕРЫ:");
      expect(version.exitCode).toBe(0);
      expect(version.stderr).toBe("");
    },
  );

  test("start передаёт явные home/config/project/actor и port 0, не открывая отсутствующий проект в CLI", async () => {
    await withCliFixture(async (cli) => {
      let actualOptions: RuntimeOptions | undefined;
      let actualInput: ServerStartInput | undefined;
      const server = {
        ...createServerClient({
          cwd: cli.root,
          env: {},
          executablePath: "/missing",
          userHome: cli.root,
          version: "test",
        }),
        /**
         * Наблюдает аргументы process-порта без binary/native manager.
         */
        async start(
          options: RuntimeOptions,
          input: ServerStartInput,
        ): Promise<ServerInstanceStatus> {
          actualOptions = options;
          actualInput = input;
          return observed;
        },
      };

      const response = await cli.success(
        [
          "server",
          "start",
          "--home",
          "relative home",
          "--config",
          "missing.json",
          "--project",
          "commerce",
          "--actor",
          "  exact actor  ",
          "--port",
          "0",
        ],
        { server },
      );

      expect(response.data).toEqual(observed);
      expect(actualOptions).toEqual({
        cwd: cli.runtime.cwd,
        home: "relative home",
        config: "missing.json",
        project: "commerce",
      });
      expect(actualInput).toEqual({ actor: "  exact actor  ", port: 0 });
    }, "server-web/lifecycle/unit-fixtures");
  });

  test.each([
    { action: "stop", args: ["stop"] },
    { action: "restart", args: ["restart"] },
    { action: "start", args: ["start", "--port", "65536"] },
    { action: "run", args: ["run", "--port", "-1"] },
  ])("$action отвергает неверный ввод до поиска компонента", async ({ action, args }) => {
    const answer = await invokeIsolatedCli(["server", ...args, "--format", "json"]);

    expect(answer.exitCode).toBe(2);
    expect(answer.stdout).toBe("");
    expect(answer.stderr).not.toContain("SERVER_BINARY_NOT_FOUND");
    expect(JSON.parse(answer.stderr).error.helpCommand).toBe(`relay server ${action} --help`);
  });
});
