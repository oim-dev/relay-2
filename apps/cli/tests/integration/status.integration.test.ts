import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  acquireServerInstance,
  createServerLaunch,
  initializeProject,
} from "@relay/project-runtime";
import { version } from "../../package.json";
import { withCliFixture } from "./helpers/cli-fixture";
import { arrayValue, objectValue } from "./helpers/responses";

describe("Команда relay status", () => {
  test("вне проекта показывает бинарник, все проекты home и dev-сервер в text/JSON", async () => {
    await withCliFixture(async (cli) => {
      const first = cli.createProject();
      const second = cli.createProject(join(cli.root, "another-project"));
      const home = String(cli.runtime.env.RELAY_HOME);
      const stopped = createServerLaunch(
        { cwd: cli.runtime.cwd, home },
        { version, mode: "foreground" },
      );
      const invalidInstanceId = crypto.randomUUID();
      const invalidDirectory = join(home, "servers", invalidInstanceId);
      mkdirSync(invalidDirectory);
      writeFileSync(join(invalidDirectory, "launch.json"), "{}");
      const launch = createServerLaunch(
        { cwd: cli.runtime.cwd, home },
        {
          version,
          mode: "foreground",
          development: { webUrl: "http://127.0.0.1:5174" },
        },
      );
      const registration = acquireServerInstance(launch);
      let gitRequests = 0;
      const overrides = {
        cwd: cli.root,
        executablePath: process.execPath,
        env: {
          ...cli.runtime.env,
          RELAY_UNKNOWN_SECRET: "не выводить",
          RELAY_SERVER_BIN: "/missing-server-binary",
        },
        gitSync: {
          /**
           * Любая попытка Git считается нарушением readonly status, даже если CLI подавит её ошибку.
           */
          async request(): Promise<never> {
            gitRequests += 1;
            throw new Error("status не должен обращаться к Git Sync");
          },
        },
      };
      try {
        registration.ready({
          url: "http://127.0.0.1:3210",
          projects: [],
          /**
           * Сводка не останавливает сервер; registration закрывается владельцем fixture в finally.
           */
          onStop(): void {},
        });

        const response = await cli.success(["status"], overrides);
        const text = await cli.invoke(["status"], overrides);

        expect(response.data).toMatchObject({
          version: 1,
          home,
          cli: { version, executablePath: realpathSync(process.execPath) },
          context: { cwd: cli.root, configPath: null },
          servers: {
            running: 1,
            registered: 3,
          },
        });
        const data = objectValue(response.data);
        const projects = arrayValue(data.projects);
        expect(projects).toHaveLength(2);
        expect(projects).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              projectId: first.projectId,
              databasePath: first.databasePath,
              configPaths: [first.configPath],
              current: false,
            }),
            expect.objectContaining({
              projectId: second.projectId,
              databasePath: second.databasePath,
              configPaths: [],
              current: false,
            }),
          ]),
        );
        expect(objectValue(data.servers).items).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              instanceId: launch.instanceId,
              state: "ready",
              development: { webUrl: "http://127.0.0.1:5174" },
            }),
            expect.objectContaining({ instanceId: stopped.instanceId, state: "stopped" }),
            expect.objectContaining({
              instanceId: invalidInstanceId,
              state: "invalid",
              error: { code: "SERVER_REGISTRY_INVALID", message: expect.any(String) },
            }),
          ]),
        );
        expect(data.environment).toEqual({
          RELAY_HOME: home,
          RELAY_ACTOR: "agent",
          RELAY_CONFIG: null,
          RELAY_CLI_BIN: null,
          RELAY_SERVER_BIN: "/missing-server-binary",
          RELAY_API_URL: null,
          RELAY_WEB_PORT: null,
          RELAY_WEB_ORIGIN: null,
        });
        expect(gitRequests).toBe(0);
        expect(text).toMatchObject({ code: 0, stderr: "" });
        expect(text.stdout).toContain(realpathSync(process.execPath));
        expect(text.stdout).toContain(first.databasePath);
        expect(text.stdout).toContain(second.databasePath);
        expect(text.stdout).toContain("готов [dev]");
        expect(text.stdout).toContain("Web: http://127.0.0.1:5174");
        expect(text.stdout).not.toContain("не выводить");
      } finally {
        registration.close();
      }
    }, "dev-mode-test-review/status-fixtures");
  });

  test("пустая установка успешна без проекта, серверного бинарника и создания home", async () => {
    await withCliFixture(async (cli) => {
      const response = await cli.success(["status"]);

      expect(response.data).toMatchObject({
        projects: [],
        configurations: [],
        servers: { running: 0, registered: 0 },
      });
      expect(existsSync(String(cli.runtime.env.RELAY_HOME))).toBe(false);
    }, "dev-mode-test-review/status-fixtures");
  });

  test("явный --home выбирает и проекты, и серверы другой установки, несмотря на неисправный --config", async () => {
    await withCliFixture(async (cli) => {
      const outside = cli.createProject();
      const originalHome = String(cli.runtime.env.RELAY_HOME);
      createServerLaunch(
        { cwd: cli.runtime.cwd, home: originalHome },
        { version, mode: "foreground" },
      );
      const selectedHome = join(cli.root, "selected-home");
      const selectedCwd = join(cli.root, "selected-project");
      const selected = initializeProject({ cwd: selectedCwd, home: selectedHome });
      const selectedServer = createServerLaunch(
        { cwd: selectedCwd, home: selectedHome },
        { version, mode: "foreground" },
      );
      const missingConfig = join(cli.root, "missing-config.json");

      const response = await cli.success([
        "status",
        "--home",
        selectedHome,
        "--config",
        missingConfig,
      ]);

      expect(response.data).toMatchObject({
        home: selectedHome,
        projects: [{ projectId: selected.projectId, databasePath: selected.databasePath }],
        servers: {
          running: 0,
          registered: 1,
          items: [{ instanceId: selectedServer.instanceId, state: "stopped" }],
        },
        context: { error: { code: "CONFIG_NOT_FOUND" } },
        environment: { RELAY_HOME: originalHome },
      });
      expect(JSON.stringify(objectValue(response.data).projects)).not.toContain(outside.projectId);
      expect(existsSync(missingConfig)).toBe(false);
    }, "dev-mode-test-review/status-fixtures");
  });
});
