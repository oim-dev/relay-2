import { describe, expect, test } from "bun:test";
import { RelayError } from "@relay/contracts";
import type { GitSyncEnvironment } from "./client.types";
import type { ProcessCommand, ProcessResult } from "./process.types";
import type { GitSyncSupervisorStatus } from "./supervisor.types";
import { createServiceConfiguration, quoteWindowsArgument } from "./service-configuration";
import { controlGitSyncService, gitSyncHome } from "./service";
import type { ServicePlatform } from "./service.types";
import type { ServiceTestFixture } from "./service.test.types";

const platforms = ["linux", "darwin", "win32"] as const;
const windowsUser = "TEAM\\Мария";

/**
 * Подставляет файловую систему и native manager, не устанавливая службы на машине теста.
 * Команды сохраняются для проверки системных границ; Windows COM возвращает реальное состояние fixture.
 */
function serviceFixture(platform: ServicePlatform): ServiceTestFixture {
  const files = new Map<string, string>();
  const commands: ProcessCommand[] = [];
  const home = platform === "win32" ? "C:\\Users\\Мария\\relay data" : "/users/Мария/relay data";
  const binary =
    platform === "win32"
      ? "C:\\Program Files\\Relay\\relay-git-sync.exe"
      : "/opt/Relay версия/relay-git-sync";
  let task = false;
  let running = false;
  let systemRegistered = false;
  let launchLoaded = false;
  const configuration = createServiceConfiguration({
    platform,
    home,
    binary,
    userHome: home,
    userName: windowsUser,
  });
  const environment: GitSyncEnvironment = {
    cwd: "/fixture",
    env: { PATH: "/fixture/bin" },
    executablePath: "/fixture/relay",
    version: "0.0.0",
    userHome: home,
    userName: windowsUser,
    userId: 1001,
    platform,
    /**
     * Подтверждает отдельную health-границу, не выводя её из успешного native start.
     */
    supervisorProbe: async (_home, waitForReady): Promise<GitSyncSupervisorStatus> => ({
      actual: waitForReady ? "running" : "stopped",
      responsive: waitForReady,
      instance: waitForReady ? "fixture-instance" : null,
      release: waitForReady ? "0.0.0/git-sync-v1" : null,
      pid: waitForReady ? 1234 : null,
      heartbeat: waitForReady ? "2026-10-24T00:00:00Z" : null,
    }),
    serviceFiles: {
      /**
       * Читает только память fixture.
       */
      read: (path): string | undefined => files.get(path),
      /**
       * Сохраняет публикацию для проверки exact path и содержимого.
       */
      write: (path, content): void => {
        files.set(path, content);
      },
      /**
       * Удаляет только явно указанный служебный файл.
       */
      remove: (path): void => {
        files.delete(path);
      },
    },
    /**
     * Моделирует проверяемые native-исходы, не запуская утилиты ОС.
     */
    runner: async (command): Promise<ProcessResult> => {
      commands.push(command);
      if (command.executable === "powershell.exe") {
        return {
          exitCode: 0,
          stderr: "",
          stdout: JSON.stringify(
            task
              ? {
                  exists: true,
                  state: running ? 4 : 3,
                  enabled: true,
                  description: configuration.marker,
                }
              : { exists: false },
          ),
        };
      }
      if (command.args.includes("/Create")) {
        task = true;
      }
      if (command.args.includes("/Run")) {
        running = true;
      }
      if (command.args.includes("/End")) {
        running = false;
      }
      if (command.args.includes("/Delete")) {
        task = false;
      }
      if (command.executable === "systemctl") {
        if (command.args.includes("daemon-reload")) {
          systemRegistered = files.has(configuration.path);
        }
        if (command.args.includes("enable") || command.args.includes("restart")) {
          running = true;
        }
        if (command.args.includes("disable")) {
          running = false;
        }
      }
      if (command.executable === "launchctl") {
        if (command.args[0] === "bootstrap") {
          launchLoaded = true;
        }
        if (command.args[0] === "bootout") {
          launchLoaded = false;
        }
      }
      if (command.args[0] === "print") {
        return command.args[1] === "gui/1001" || launchLoaded
          ? { exitCode: 0, stdout: "unstructured native diagnostic", stderr: "" }
          : { exitCode: 113, stdout: "", stderr: "service not found" };
      }
      return {
        exitCode: 0,
        stderr: "",
        stdout: command.args.includes("show")
          ? `LoadState=${systemRegistered ? "loaded" : "not-found"}\nActiveState=${running ? "active" : "inactive"}\nUnitFileState=${running ? "enabled" : "disabled"}\n`
          : "",
      };
    },
  };
  return { files, commands, environment, home, binary, configuration };
}

describe("Конфигурации пользовательского supervisor", () => {
  test.each([
    {
      platform: "linux",
      cwd: "/fixture/project",
      home: "../дом Relay",
      expected: "/fixture/дом Relay",
    },
    {
      platform: "darwin",
      cwd: "/fixture/project",
      home: "../дом Relay",
      expected: "/fixture/дом Relay",
    },
    {
      platform: "win32",
      cwd: "C:\\fixture\\project",
      home: "..\\дом Relay",
      expected: "C:\\fixture\\дом Relay",
    },
  ])(
    "$platform: home сохраняет синтаксис целевой ОС на любом хосте",
    ({ platform, cwd, home, expected }) => {
      const resolved = gitSyncHome({ cwd, home }, platform);

      expect(resolved).toBe(expected);
    },
  );

  test("systemd сохраняет argv с пробелами, кавычками, Unicode и буквальными $/%", () => {
    const config = createServiceConfiguration({
      platform: "linux",
      binary: '/opt/Мой "Relay"/sync%$bin',
      home: "/home/Ира/data %$",
      userHome: "/home/Ира",
    });

    expect(config.content).toContain(
      'Type=exec\nExecStart="/bin/sh" "-c" "exec \\"$$@\\"" "relay-git-sync" "/opt/Мой \\"Relay\\"/sync%%$$bin" "supervise" "--home" "/home/Ира/data %%$$"',
    );
    expect(config.content).toContain("KillMode=control-group");
    expect(config.content).toContain("WantedBy=default.target");
    expect(config.content).not.toContain("sudo");
  });

  test("LaunchAgent кодирует XML-значения, сохраняя раздельные ProgramArguments", () => {
    const config = createServiceConfiguration({
      platform: "darwin",
      binary: '/Users/Ира/Relay & "team"/<sync>',
      home: "/Users/Ира/data 'one'",
      userHome: "/Users/Ира",
    });

    expect(config.path).toContain("/Library/LaunchAgents/dev.relay.git-sync.");
    expect(config.content).toContain(
      "<string>/Users/Ира/Relay &amp; &quot;team&quot;/&lt;sync&gt;</string><string>supervise</string><string>--home</string><string>/Users/Ира/data &apos;one&apos;</string>",
    );
    expect(config.content).toContain("<key>RunAtLoad</key><true/>");
    expect(config.content).toContain("<key>SuccessfulExit</key><false/>");
  });

  test("Windows task использует InteractiveToken, текущего пользователя и бессрочный запуск", () => {
    const { configuration } = serviceFixture("win32");

    expect(configuration.content).toContain("<UserId>TEAM\\Мария</UserId>");
    expect(configuration.content).toContain("<LogonType>InteractiveToken</LogonType>");
    expect(configuration.content).toContain("<RunLevel>LeastPrivilege</RunLevel>");
    expect(configuration.content).toContain("<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>");
    expect(configuration.content).toContain(
      "<RestartOnFailure><Interval>PT1M</Interval><Count>999</Count>",
    );
    expect(configuration.content).toContain(
      "<Command>C:\\Program Files\\Relay\\relay-git-sync.exe</Command>",
    );
    expect(configuration.content).toContain(
      "<Arguments>&quot;supervise&quot; &quot;--home&quot; &quot;C:\\Users\\Мария\\relay data&quot;</Arguments>",
    );
    expect(configuration.content).not.toContain("S4U");
    expect(quoteWindowsArgument("C:\\a b\\")).toBe('"C:\\a b\\\\"');
    expect(quoteWindowsArgument('one"two')).toBe('"one\\"two"');
  });

  test("Windows-пользователи одного home получают разные системные имена задач", () => {
    const input = {
      platform: "win32" as const,
      binary: "C:\\Relay\\sync.exe",
      home: "C:\\Shared\\relay",
      userHome: "C:\\Users\\one",
    };
    const first = createServiceConfiguration({ ...input, userName: "TEAM\\one" });
    const second = createServiceConfiguration({ ...input, userName: "TEAM\\two" });

    expect(first.id).not.toBe(second.id);
    expect(first.marker).not.toBe(second.marker);
  });

  test("Windows principal получается из native WindowsIdentity, включая Unicode", async () => {
    const fixture = serviceFixture("win32");
    const { userName: _userName, ...withoutIdentity } = fixture.environment;
    let identityCalls = 0;
    const environment: GitSyncEnvironment = {
      ...withoutIdentity,
      /**
       * Только запрос identity возвращает имя пользователя; lifecycle использует обычный fake manager.
       */
      runner: async (command): Promise<ProcessResult> => {
        const script = Buffer.from(command.args.at(-1) ?? "", "base64").toString("utf16le");
        if (command.executable === "powershell.exe" && script.includes("WindowsIdentity")) {
          identityCalls++;
          return { exitCode: 0, stdout: `${windowsUser}\n`, stderr: "" };
        }
        if (!fixture.environment.runner) {
          throw new Error("Не настроен runner fixture");
        }
        return fixture.environment.runner(command);
      },
    };

    const status = await controlGitSyncService(
      "enable",
      { cwd: "/fixture", home: fixture.home },
      environment,
      fixture.binary,
    );

    expect(identityCalls).toBe(1);
    expect(status.id).toBe(fixture.configuration.id);
    expect(fixture.files.get(status.configPath)).toContain("<UserId>TEAM\\Мария</UserId>");
  });

  test.each(platforms)(
    "%s: enable запускает native manager, disable удаляет только свой файл",
    async (platform) => {
      const fixture = serviceFixture(platform);
      fixture.files.set("project.sqlite", "user project");

      const enabled = await controlGitSyncService(
        "enable",
        { cwd: "/fixture", home: fixture.home },
        fixture.environment,
        fixture.binary,
      );
      const disabled = await controlGitSyncService(
        "disable",
        { cwd: "/fixture", home: fixture.home },
        fixture.environment,
      );

      expect(enabled.installed).toBe(true);
      expect(disabled).toMatchObject({ installed: false, state: "stopped" });
      expect([...fixture.files]).toEqual([["project.sqlite", "user project"]]);
      const nativeArgs = fixture.commands.map((command) => command.args);
      if (platform === "linux") {
        expect(nativeArgs).toContainEqual(["--user", "enable", "--now", enabled.id]);
        expect(nativeArgs).toContainEqual(["--user", "disable", "--now", enabled.id]);
      } else if (platform === "darwin") {
        expect(nativeArgs).toContainEqual(["bootstrap", "gui/1001", enabled.configPath]);
        expect(nativeArgs).toContainEqual(["kickstart", "-k", `gui/1001/${enabled.id}`]);
        expect(enabled.state).toBe("unknown");
      } else {
        expect(nativeArgs).toContainEqual([
          "/Create",
          "/TN",
          enabled.id,
          "/XML",
          enabled.configPath,
          "/F",
        ]);
        expect(nativeArgs).toContainEqual(["/Run", "/TN", enabled.id]);
        expect(nativeArgs).toContainEqual(["/End", "/TN", enabled.id]);
        expect(nativeArgs).toContainEqual(["/Delete", "/TN", enabled.id, "/F"]);
      }
      expect(
        fixture.commands.every(
          (command) => command.cwd === "/fixture" && command.env.PATH === "/fixture/bin",
        ),
      ).toBe(true);
    },
  );

  test.each(platforms)(
    "%s: повтор enable/disable сохраняет одну собственную регистрацию и отдельную readiness",
    async (platform) => {
      const fixture = serviceFixture(platform);
      const options = { cwd: "/fixture", home: fixture.home };
      const first = await controlGitSyncService(
        "enable",
        options,
        fixture.environment,
        fixture.binary,
      );
      const repeated = await controlGitSyncService(
        "enable",
        options,
        fixture.environment,
        fixture.binary,
      );

      expect(repeated.id).toBe(first.id);
      expect(repeated).toMatchObject({
        installed: true,
        desiredRegistration: "enabled",
        registered: true,
        supervisor: { responsive: true, actual: "running" },
      });
      expect(fixture.files.size).toBe(1);
      await controlGitSyncService("disable", options, fixture.environment);
      const disabled = await controlGitSyncService("disable", options, fixture.environment);

      expect(disabled).toMatchObject({
        installed: false,
        desiredRegistration: "disabled",
        registered: false,
        state: "stopped",
        supervisor: { responsive: false },
      });
      expect(fixture.files.size).toBe(0);
    },
  );

  test.each(platforms)(
    "%s: чужой файл не заменяется и native manager не вызывается",
    async (platform) => {
      const fixture = serviceFixture(platform);
      // Путь рассчитывается из home в синтаксисе выбранной платформы, независимо от ОС набора.
      await controlGitSyncService(
        "enable",
        { cwd: "/fixture", home: fixture.home },
        fixture.environment,
        fixture.binary,
      );
      const path = [...fixture.files.keys()][0];
      if (!path) {
        throw new Error("Служба не сохранила конфигурацию");
      }
      fixture.files.set(path, "foreign");
      fixture.commands.length = 0;

      await expect(
        controlGitSyncService(
          "disable",
          { cwd: "/fixture", home: fixture.home },
          fixture.environment,
        ),
      ).rejects.toMatchObject({ code: "GIT_SYNC_SERVICE_OWNERSHIP", exitCode: 4 });

      expect(fixture.files.get(path)).toBe("foreign");
      expect(fixture.commands).toEqual([]);
    },
  );

  test("native отказ сохраняет реальный код и диагностику вместо успешной установки", async () => {
    const fixture = serviceFixture("linux");
    const environment = {
      ...fixture.environment,
      /**
       * Отказывает на native-границе до изменения каких-либо регистраций.
       */
      runner: async (): Promise<ProcessResult> => ({
        exitCode: 5,
        stdout: "",
        stderr: "Access denied",
      }),
    };

    await expect(
      controlGitSyncService(
        "enable",
        { cwd: "/fixture", home: fixture.home },
        environment,
        fixture.binary,
      ),
    ).rejects.toMatchObject({
      code: "GIT_SYNC_SERVICE_FAILED",
      exitCode: 5,
      details: { nativeExitCode: 5, stderr: "Access denied" },
    });
  });

  test.each(platforms)(
    "%s: существующая чужая native-регистрация не получает наш файл владения",
    async (platform) => {
      const fixture = serviceFixture(platform);
      const commands: ProcessCommand[] = [];
      const environment = {
        ...fixture.environment,
        /**
         * Менеджер уже знает чужую регистрацию, хотя нашего локального манифеста нет.
         */
        runner: async (command: ProcessCommand): Promise<ProcessResult> => {
          commands.push(command);
          if (platform === "win32") {
            return {
              exitCode: 0,
              stderr: "",
              stdout: JSON.stringify({
                exists: true,
                state: 3,
                enabled: true,
                description: "foreign",
              }),
            };
          }
          return {
            exitCode: 0,
            stderr: "",
            stdout:
              platform === "linux"
                ? "LoadState=loaded\nActiveState=inactive\nUnitFileState=disabled\n"
                : "opaque launchd text",
          };
        },
      };

      await expect(
        controlGitSyncService(
          "enable",
          { cwd: "/fixture", home: fixture.home },
          environment,
          fixture.binary,
        ),
      ).rejects.toMatchObject({ code: "GIT_SYNC_SERVICE_OWNERSHIP", exitCode: 4 });
      expect(fixture.files.size).toBe(0);
      expect(
        commands.some(
          (command) =>
            command.args.includes("bootstrap") ||
            command.args.includes("/Create") ||
            command.args.includes("enable"),
        ),
      ).toBe(false);
    },
  );

  test.each(platforms)(
    "%s: существующий foreground instance не подтверждает readiness native службы",
    async (platform) => {
      const fixture = serviceFixture(platform);
      const environment: GitSyncEnvironment = {
        ...fixture.environment,
        /**
         * Старый независимый supervisor отвечает до и после запуска native manager.
         */
        supervisorProbe: async (): Promise<GitSyncSupervisorStatus> => ({
          actual: "running",
          responsive: true,
          instance: "foreground-instance",
          release: "0.0.0/git-sync-v1",
          pid: 1234,
          heartbeat: "2026-10-24T00:00:00Z",
        }),
      };

      await expect(
        controlGitSyncService(
          "enable",
          { cwd: "/fixture", home: fixture.home },
          environment,
          fixture.binary,
        ),
      ).rejects.toMatchObject({
        code: "GIT_SYNC_NOT_READY",
        details: { supervisor: { instance: "foreground-instance" } },
      });
      expect(fixture.files.size).toBe(1);
    },
  );

  test.each(platforms)(
    "%s: отказ регистрации после записи файла остаётся наблюдаемым и допускает повтор enable",
    async (platform) => {
      const fixture = serviceFixture(platform);
      const runner = fixture.environment.runner;
      if (!runner) {
        throw new Error("Не настроен runner fixture");
      }
      let failRegistration = true;
      const environment: GitSyncEnvironment = {
        ...fixture.environment,
        /**
         * Первый native register отказывает после публикации собственного манифеста.
         */
        runner: async (command): Promise<ProcessResult> => {
          if (
            failRegistration &&
            command.args.some((argument) => ["enable", "bootstrap", "/Create"].includes(argument))
          ) {
            failRegistration = false;
            return { exitCode: 5, stdout: "", stderr: "registration denied" };
          }
          return runner(command);
        },
      };
      const options = { cwd: "/fixture", home: fixture.home };

      await expect(
        controlGitSyncService("enable", options, environment, fixture.binary),
      ).rejects.toMatchObject({ code: "GIT_SYNC_SERVICE_FAILED", exitCode: 5 });
      const failed = await controlGitSyncService("status", options, environment);

      expect(failed).toMatchObject({
        installed: true,
        desiredRegistration: "enabled",
        enabled: platform === "darwin" ? null : false,
        supervisor: { actual: "stopped", responsive: false },
      });
      expect(fixture.files.size).toBe(1);
      const recovered = await controlGitSyncService("enable", options, environment, fixture.binary);
      expect(recovered).toMatchObject({
        registered: true,
        enabled: true,
        supervisor: { actual: "running", responsive: true },
      });
      expect(fixture.files.size).toBe(1);
    },
  );

  test.each(platforms)(
    "%s: успешный native start без readiness не объявляется готовой службой",
    async (platform) => {
      const fixture = serviceFixture(platform);
      const environment = {
        ...fixture.environment,
        /**
         * Startup завершён менеджером, но приложение не подтвердило свой instance.
         */
        supervisorProbe: async (
          home: string,
          waitForReady: boolean,
        ): Promise<GitSyncSupervisorStatus> => {
          if (!waitForReady && fixture.environment.supervisorProbe) {
            return fixture.environment.supervisorProbe(home, false);
          }
          throw new RelayError("GIT_SYNC_NOT_READY", "Нет readiness", 4);
        },
      };

      await expect(
        controlGitSyncService(
          "enable",
          { cwd: "/fixture", home: fixture.home },
          environment,
          fixture.binary,
        ),
      ).rejects.toMatchObject({ code: "GIT_SYNC_NOT_READY", exitCode: 4 });
      expect(fixture.files.size).toBe(1);
    },
  );

  test("управляющий перевод строки отвергается до генерации service", () => {
    expect(() =>
      createServiceConfiguration({
        platform: "linux",
        binary: "/bin/relay\nExecStart=/bad",
        home: "/data",
        userHome: "/user",
      }),
    ).toThrow(RelayError);
  });
});
