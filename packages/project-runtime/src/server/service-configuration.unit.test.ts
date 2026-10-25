import { describe, expect, test } from "bun:test";
import { createServerServiceConfiguration } from "./service-configuration";
import type { ServerLaunch } from "./server.types";

const launch: ServerLaunch = {
  protocol: 1,
  instanceId: "00000000-0000-0000-0000-000000000001",
  version: "test",
  home: "/data/Релей",
  path: "/data/Релей/servers/00000000-0000-0000-0000-000000000001/launch.json",
  scope: { kind: "workspace", configPath: "/workspace/relay.workspace.json", project: null },
  options: { cwd: "/workspace", config: "/workspace/relay.workspace.json", home: "/data/Релей" },
  actor: "web",
  port: 0,
  mode: "service",
};

describe("Native-конфигурация независимого Server", () => {
  test("systemd публикует точный executable и run --launch отдельными аргументами без подстановок пути", () => {
    const config = createServerServiceConfiguration({
      platform: "linux",
      launch,
      binary: '/opt/Мой "Relay"/server%$bin',
      userHome: "/users/test",
    });

    const commands = [...config.content.matchAll(/^ExecStart=(.+)$/gm)].map((match) => match[1]);

    expect(commands).toEqual([
      '"/bin/sh" "-c" "exec \\"$$@\\"" "relay-server" "/opt/Мой \\"Relay\\"/server%%$$bin" "run" "--launch" "/data/Релей/servers/00000000-0000-0000-0000-000000000001/launch.json"',
    ]);
  });

  test("LaunchAgent публикует executable и run --launch раздельными ProgramArguments с экранированием XML", () => {
    const config = createServerServiceConfiguration({
      platform: "darwin",
      launch,
      binary: '/Applications/Relay & "team"/<server>',
      userHome: "/users/test",
    });

    const commands = [
      ...config.content.matchAll(/<key>ProgramArguments<\/key><array>(.*?)<\/array>/gs),
    ].map((match) => match[1]);

    expect(commands).toEqual([
      "<string>/Applications/Relay &amp; &quot;team&quot;/&lt;server&gt;</string><string>run</string><string>--launch</string><string>/data/Релей/servers/00000000-0000-0000-0000-000000000001/launch.json</string>",
    ]);
  });

  test("Windows task публикует точный Command и run --launch с одним Unicode путём манифеста", () => {
    const home = "C:\\Users\\Ира\\Relay data";
    const configPath = "C:\\workspace\\relay.workspace.json";
    const windowsLaunch: ServerLaunch = {
      ...launch,
      home,
      path: `${home}\\servers\\${launch.instanceId}\\launch.json`,
      scope: { kind: "workspace", configPath, project: null },
      options: { cwd: "C:\\workspace", config: configPath, home },
    };

    const config = createServerServiceConfiguration({
      platform: "win32",
      launch: windowsLaunch,
      binary: "C:\\Program Files\\Relay & team\\relay-server.exe",
      userHome: "C:\\Users\\Ира",
      userName: "DOMAIN\\Ира",
    });

    const commands = [...config.content.matchAll(/<Exec>(.*?)<\/Exec>/gs)].map((match) => match[1]);
    expect(commands).toEqual([
      "<Command>C:\\Program Files\\Relay &amp; team\\relay-server.exe</Command><Arguments>&quot;run&quot; &quot;--launch&quot; &quot;C:\\Users\\Ира\\Relay data\\servers\\00000000-0000-0000-0000-000000000001\\launch.json&quot;</Arguments>",
    ]);
  });

  test.each(["linux", "darwin", "win32"] as const)(
    "%s адресует отдельный UUID и launch без foreground parent lease",
    (platform) => {
      const input = {
        platform,
        launch,
        binary: "/bin/relay-server",
        userHome: "/users/test",
        userName: "DOMAIN\\test",
      };

      const secondId = "00000000-0000-0000-0000-000000000002";

      const first = createServerServiceConfiguration(input);
      const second = createServerServiceConfiguration({
        ...input,
        launch: {
          ...launch,
          instanceId: secondId,
          path: `${launch.home}/servers/${secondId}/launch.json`,
        },
      });

      expect(first.id).not.toBe(second.id);
      expect(first.path).not.toBe(second.path);
      expect(first.content).not.toContain("--parent-lease");
      expect(first.content).not.toContain("supervise");
      expect(first.content).toContain(first.marker);
    },
  );
});
