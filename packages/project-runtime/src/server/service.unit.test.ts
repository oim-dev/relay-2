import { describe, expect, test } from "bun:test";
import type { NativePlatform } from "../native/platform.types";
import type { ServiceConfiguration } from "../native/user-service/service.types";
import type { ProcessCommand, ProcessRunner, ProcessResult } from "../git-sync/process.types";
import { controlServerService } from "./service";
import { createServerServiceConfiguration } from "./service-configuration";
import type { ServerEnvironment, ServerLaunch } from "./server.types";

const platforms = ["linux", "darwin", "win32"] as const;
const binary = "/fixture/relay-server";
const launch: ServerLaunch = {
  protocol: 1,
  instanceId: "00000000-0000-0000-0000-000000000001",
  version: "test",
  home: "/fixture/relay-home",
  path: "/fixture/relay-home/servers/00000000-0000-0000-0000-000000000001/launch.json",
  scope: { kind: "workspace", configPath: "/fixture/relay.workspace.json", project: null },
  options: {
    cwd: "/fixture",
    config: "/fixture/relay.workspace.json",
    home: "/fixture/relay-home",
  },
  actor: "web",
  port: 0,
  mode: "service",
};

/**
 * Создаёт native-конфигурацию без публикации и без обращения к реестру launch.
 */
function serverConfiguration(platform: NativePlatform): ServiceConfiguration {
  return createServerServiceConfiguration({
    platform,
    launch,
    binary,
    userHome: "/fixture/user",
    userName: "TEAM\\test",
  });
}

/**
 * Подменяет только файлы и команды менеджера; тесты ниже завершаются до обращения к lease/SQLite.
 * Владение памятью и массивом команд принадлежит отдельному тесту.
 */
function serverEnvironment(
  platform: NativePlatform,
  files: Map<string, string>,
  runner: ProcessRunner,
): ServerEnvironment {
  return {
    platform,
    cwd: "/fixture",
    env: { PATH: "/fixture/bin" },
    executablePath: "/fixture/relay",
    version: "test",
    userHome: "/fixture/user",
    userName: "TEAM\\test",
    userId: 1001,
    runner,
    serviceFiles: {
      /**
       * Читает только собственный in-memory набор.
       */
      read: (path): string | undefined => files.get(path),
      /**
       * Сохраняет опубликованный файл для проверки отсутствия преждевременной замены.
       */
      write: (path, content): void => {
        files.set(path, content);
      },
      /**
       * Удаляет только указанный манифест fixture.
       */
      remove: (path): void => {
        files.delete(path);
      },
    },
  };
}

describe("Выбор native-адаптера службы Server", () => {
  test.each(platforms)("%s: чужой локальный файл запрещает native-команды", async (platform) => {
    const config = serverConfiguration(platform);
    const files = new Map([[config.path, "foreign"]]);
    const commands: ProcessCommand[] = [];
    const environment = serverEnvironment(platform, files, async (command) => {
      commands.push(command);
      throw new Error("Manager не должен вызываться до проверки файла");
    });

    await expect(controlServerService("disable", launch, environment)).rejects.toMatchObject({
      code: "SERVER_SERVICE_OWNERSHIP",
      exitCode: 4,
      details: { path: config.path },
    });

    expect([...files]).toEqual([[config.path, "foreign"]]);
    expect(commands).toEqual([]);
  });

  test.each(platforms)(
    "%s: disable без своего файла не трогает чужую native-регистрацию",
    async (platform) => {
      const config = serverConfiguration(platform);
      const files = new Map<string, string>();
      const commands: ProcessCommand[] = [];
      const nativeResponses = {
        linux: "LoadState=loaded\n",
        darwin: "opaque launchctl diagnostic",
        win32: JSON.stringify({
          exists: true,
          description: "foreign",
          state: 3,
          enabled: true,
          runningInstances: 0,
        }),
      };
      const environment = serverEnvironment(platform, files, async (command) => {
        commands.push(command);
        return { exitCode: 0, stdout: nativeResponses[platform], stderr: "" };
      });

      await expect(controlServerService("disable", launch, environment)).rejects.toMatchObject({
        code: "SERVER_SERVICE_OWNERSHIP",
        exitCode: 4,
        details: { id: config.id },
      });

      const expectedReads = {
        linux: [["--user", "show", config.id, "--property=LoadState", "--no-pager"]],
        darwin: [
          ["print", "gui/1001"],
          ["print", `gui/1001/${config.id}`],
        ],
        win32: [["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand"]],
      };
      expect(
        commands.map((command) => (platform === "win32" ? command.args.slice(0, 4) : command.args)),
      ).toEqual(expectedReads[platform]);
      expect(files.size).toBe(0);
    },
  );

  test("macOS: отказ bootout сохраняет прежний файл Server и native exit в details", async () => {
    const config = serverConfiguration("darwin");
    const previous = `${config.marker}\nprevious executable`;
    const files = new Map([[config.path, previous]]);
    const commands: ProcessCommand[] = [];
    const environment = serverEnvironment("darwin", files, async (command) => {
      commands.push(command);
      return {
        exitCode: command.args[0] === "bootout" ? 9 : 0,
        stdout: "",
        stderr: "bootout denied",
      };
    });

    await expect(controlServerService("enable", launch, environment, binary)).rejects.toMatchObject(
      {
        code: "SERVER_SERVICE_FAILED",
        exitCode: 4,
        details: { nativeExitCode: 9, stderr: "bootout denied" },
      },
    );

    expect(files.get(config.path)).toBe(previous);
    expect(commands.map((command) => command.args)).toEqual([
      ["print", "gui/1001"],
      ["print", `gui/1001/${config.id}`],
      ["bootout", `gui/1001/${config.id}`],
    ]);
  });

  test("macOS: Server публикуется после bootout и запускается bootstrap без kickstart", async () => {
    const config = serverConfiguration("darwin");
    const previous = `${config.marker}\nprevious executable`;
    const files = new Map([[config.path, previous]]);
    const commands: ProcessCommand[] = [];
    const environment = serverEnvironment("darwin", files, async (command) => {
      commands.push(command);
      if (command.args[0] === "bootout") {
        expect(files.get(config.path)).toBe(previous);
      }
      if (command.args[0] === "bootstrap") {
        expect(files.get(config.path)).toBe(config.content);
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    });

    await controlServerService("enable", launch, environment, binary);

    expect(commands.map((command) => command.args)).toEqual([
      ["print", "gui/1001"],
      ["print", `gui/1001/${config.id}`],
      ["bootout", `gui/1001/${config.id}`],
      ["enable", `gui/1001/${config.id}`],
      ["bootstrap", "gui/1001", config.path],
    ]);
  });

  test("Windows: повреждённый COM JSON сохраняет Server-код и причину без публикации", async () => {
    const files = new Map<string, string>();
    const environment = serverEnvironment("win32", files, async (): Promise<ProcessResult> => ({
      exitCode: 0,
      stdout: "{invalid",
      stderr: "",
    }));

    await expect(controlServerService("enable", launch, environment, binary)).rejects.toMatchObject(
      {
        code: "SERVER_SERVICE_PROTOCOL",
        exitCode: 1,
        cause: expect.any(SyntaxError),
      },
    );

    expect(files.size).toBe(0);
  });
});
