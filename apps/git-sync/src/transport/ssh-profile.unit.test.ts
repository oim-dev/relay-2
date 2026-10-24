import { describe, expect, test } from "bun:test";
import { gitCommand } from "./git";
import { probeSsh, selectSshProfile, shellWord, usesSsh } from "./ssh-profile";
import type { ProcessInput, ProcessResult } from "./process.types";

/**
 * Создаёт ответ fixture исполнителя, сохраняя байтовые stdout/stderr.
 */
function result(exitCode: number, stdout = "", stderr = ""): ProcessResult {
  return { exitCode, stdout: Buffer.from(stdout), stderr: Buffer.from(stderr) };
}

describe("Foreground Git/OpenSSH профиль", () => {
  test("каждый Git вызов запрещает detached maintenance и сохраняет environment config/SSH override", () => {
    const custom = "ssh -i 'ключ с пробелом' -o ProxyCommand='connect %h %p'";

    const command = gitCommand("/fixture", ["fetch", "origin"], {
      env: {
        GIT_SSH_COMMAND: custom,
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "http.extraHeader",
        GIT_CONFIG_VALUE_0: "Auth: secret",
      },
    });

    expect(command.args).toContain("gc.autoDetach=false");
    expect(command.args).toContain("maintenance.autoDetach=false");
    expect(command.env?.GIT_SSH_COMMAND).toBe(custom);
    expect(command.env?.GIT_CONFIG_COUNT).toBe("1");
    expect(command.env?.GIT_CONFIG_VALUE_0).toBe("Auth: secret");
  });

  test.each([
    { name: "неизвестный клиент", version: result(0, "", "OtherSSH_1.0\n") },
    { name: "отказ -V", version: result(255, "OpenSSH_for_Windows_9.5\n") },
  ])("$name: после -V не создаётся config и не исполняется -G", async ({ version }) => {
    const calls: ProcessInput[] = [];

    const probe = await probeSsh(
      { executable: "/fixture/ssh", cwd: "/несуществующий-probe-cwd" },
      async (command) => {
        calls.push(command);
        return version;
      },
    );

    expect(probe).toEqual({ executable: "/fixture/ssh", implementation: null, options: [] });
    expect(calls.map((call) => call.args)).toEqual([["-V"]]);
  });

  test("явный GIT_SSH_COMMAND не исполняется для probe и не переписывается", async () => {
    const command = "custom-helper -f -i '/ключ'";

    const profile = await selectSshProfile(
      {
        directory: "/fixture",
        remote: "git@host:repo",
        branch: "data",
        env: { GIT_SSH_COMMAND: command },
      },
      undefined,
      async () => {
        throw new Error("custom command must not be probed");
      },
    );

    expect(profile).toEqual({
      command: null,
      capability: { mode: "custom", source: "GIT_SSH_COMMAND", implementation: null, options: [] },
    });
  });

  test("core.sshCommand сохраняется и не подменяется default OpenSSH", async () => {
    const commands: ProcessInput[] = [];
    const profile = await selectSshProfile(
      {
        directory: "/fixture",
        remote: "ssh://host/repo",
        branch: "data",
        env: { GIT_SSH_COMMAND: undefined, GIT_SSH: undefined, GIT_SSH_VARIANT: undefined },
      },
      undefined,
      async (command) => {
        commands.push(command);
        return result(0, "core.sshcommand\nssh -i '/identity' -o ProxyCommand='proxy %h'\0");
      },
    );

    expect(profile.command).toBeNull();
    expect(profile.capability.source).toBe("core.sshCommand");
    expect(commands).toHaveLength(1);
  });

  test("default executable выбирается в Git окружении, реальный argv не получает -F/-f и не теряет user config", async () => {
    const commands: ProcessInput[] = [];
    const profile = await selectSshProfile(
      {
        directory: "/fixture",
        remote: "ssh://host/repo",
        branch: "data",
        env: { GIT_SSH_COMMAND: undefined, GIT_SSH: undefined, GIT_SSH_VARIANT: undefined },
      },
      undefined,
      async (command) => {
        commands.push(command);
        if (command.args.includes("config")) {
          return result(1);
        }
        return result(
          0,
          JSON.stringify({
            executable: "/Git SSH/ssh",
            implementation: "OpenSSH_9.7p1",
            options: ["ForkAfterAuthentication=no", "ControlPersist=no"],
          }),
        );
      },
      ["/Bun's tools/bun", "/project/main.ts"],
    );

    expect(commands[1]?.args.join(" ")).toContain("alias.relay-internal-ssh-profile=!");
    expect(profile.command).toBe(
      "'/Git SSH/ssh' -o 'ForkAfterAuthentication=no' -o 'ControlPersist=no'",
    );
    expect(profile.command).not.toContain(" -F");
    expect(profile.command).not.toContain(" -f");
    expect(shellWord("C:\\Users\\O'Connor\\ssh.exe", "win32")).toBe(
      "'C:/Users/O'\\''Connor/ssh.exe'",
    );
    expect(usesSsh("C:\\repo", "win32")).toBe(false);
    expect(usesSsh("git@host:repo", "linux")).toBe(true);
  });

  test("версия OpenSSH без успешного ControlPersist probe остаётся unverified без подмены команды", async () => {
    const profile = await selectSshProfile(
      {
        directory: "/fixture",
        remote: "ssh://host/repo",
        branch: "data",
        env: { GIT_SSH_COMMAND: undefined, GIT_SSH: undefined, GIT_SSH_VARIANT: undefined },
      },
      undefined,
      async (command) =>
        command.args.includes("config")
          ? result(1)
          : result(
              0,
              JSON.stringify({
                executable: "C:\\Program Files\\Git\\usr\\bin\\ssh.exe",
                implementation: "OpenSSH_10.5p1",
                options: ["ForkAfterAuthentication=no"],
              }),
            ),
    );

    expect(profile).toEqual({
      command: null,
      capability: {
        mode: "unverified",
        source: "default",
        implementation: "OpenSSH_10.5p1",
        options: [],
      },
    });
  });
});
