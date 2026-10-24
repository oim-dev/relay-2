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

  test("старый OpenSSH получает только реально поддержанный ControlPersist без сети и user config в probe", async () => {
    const calls: ProcessInput[] = [];

    const probe = await probeSsh(
      { executable: "/fixture/ssh", cwd: "/fixture", platform: "darwin" },
      async (command) => {
        calls.push(command);
        if (command.args.includes("-V")) {
          return result(0, "", "OpenSSH_7.9p1 fixture\n");
        }
        if (command.args.includes("ForkAfterAuthentication=no")) {
          return result(255, "", "unknown option");
        }
        return result(0, "controlpersist no\n");
      },
    );

    expect(probe).toMatchObject({
      implementation: "OpenSSH_7.9p1",
      options: ["ControlPersist=no"],
    });
    expect(
      calls
        .slice(1)
        .every((command) => command.args.includes("-G") && command.args.includes("/dev/null")),
    ).toBe(true);
    expect(calls.every((command) => command.timeoutMs === 3000 && command.maxBytes === 65536)).toBe(
      true,
    );
  });

  test("современный OpenSSH проверяет оба foreground options, диагностический stdout не становится командой", async () => {
    const probe = await probeSsh(
      { executable: "C:/SSH/ssh.exe", cwd: "C:/fixture", platform: "win32" },
      async (command) => {
        if (command.args.includes("-V")) {
          return result(0, "OpenSSH_for_Windows_9.5\n");
        }
        expect(command.args).toContain("NUL");
        return result(0, "identityfile user-key\nproxycommand ssh -W %h:%p gateway\n");
      },
    );

    expect(probe.options).toEqual(["ForkAfterAuthentication=no", "ControlPersist=no"]);
    expect(probe.executable).toBe("C:/SSH/ssh.exe");
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
});
