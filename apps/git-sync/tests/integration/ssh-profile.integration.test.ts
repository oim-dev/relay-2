import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { git, requireGit } from "../../src/transport/git";
import { selectSshProfile, shellWord } from "../../src/transport/ssh-profile";

/**
 * Создаёт только bare Git и файлы настроек под artifacts; предметная БД и пользовательский SSH config не нужны.
 */
async function withSshRepository(
  operation: (directory: string, env: Record<string, string | undefined>) => Promise<void>,
): Promise<void> {
  const parent = fileURLToPath(
    new URL(
      `../../../../.artifacts/${new Date().toISOString().slice(0, 10)}/git-sync-implementation/git-sync/ssh-fixtures/`,
      import.meta.url,
    ),
  );
  mkdirSync(parent, { recursive: true });
  const directory = mkdtempSync(join(parent, "profile-"));
  const empty = join(directory, "empty.gitconfig");
  writeFileSync(empty, "");
  const env = {
    GIT_CONFIG_GLOBAL: empty,
    GIT_CONFIG_SYSTEM: empty,
    GIT_CONFIG_COUNT: undefined,
    GIT_CONFIG_PARAMETERS: undefined,
    GIT_SSH_COMMAND: undefined,
    GIT_SSH: undefined,
    GIT_SSH_VARIANT: undefined,
  };
  try {
    requireGit(await git(directory, ["init", "--bare", "."], { env }), "init");
    await operation(directory, env);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

describe("SSH profile в настоящем Git окружении", () => {
  test.skipIf(Bun.which("ssh") === null)(
    "probe stdout отделён от протокола, identity/proxy и ControlMaster сохраняются",
    async () => {
      await withSshRepository(async (directory, env) => {
        const profile = await selectSshProfile({
          directory,
          env,
          remote: "ssh://relay-profile.invalid/repo",
          branch: "data",
        });
        expect(profile.capability.mode).toBe("openssh-foreground");
        expect(profile.command).not.toBeNull();
        const key = join(directory, "ключ с пробелом");
        const config = join(directory, "ssh fixture.conf");
        const fork = profile.capability.options.includes("ForkAfterAuthentication=no")
          ? "    ForkAfterAuthentication yes\n"
          : "";
        writeFileSync(
          config,
          `Host *\n    User relay-fixture\n    IdentityFile "${key.replaceAll("\\", "/")}"\n    ProxyCommand printf relay-fixture-proxy\n    ControlMaster auto\n    ControlPersist 60\n${fork}`,
        );

        const command = `${profile.command} -F ${shellWord(config)} -G relay-profile.invalid`;
        const output = requireGit(
          await git(
            directory,
            ["-c", `alias.relay-test-ssh-settings=!${command}`, "relay-test-ssh-settings"],
            { env },
          ),
          "ssh-settings",
        );

        expect(output).toContain("user relay-fixture");
        expect(output).toContain(key.replaceAll("\\", "/"));
        expect(output).toContain("proxycommand printf relay-fixture-proxy");
        expect(output).toContain("controlmaster auto");
        expect(output).toContain("controlpersist no");
        if (fork) {
          expect(output).toContain("forkafterauthentication no");
        }
      });
    },
    15_000,
  );

  test("custom core.sshCommand сохраняет точный текст, maintenance overrides не записываются в config", async () => {
    await withSshRepository(async (directory, env) => {
      const custom = "custom-helper -i 'ключ' -o ProxyCommand='proxy %h %p' -f";
      requireGit(await git(directory, ["config", "core.sshCommand", custom], { env }), "set-ssh");
      requireGit(
        await git(directory, ["config", "gc.autoDetach", "true"], { env }),
        "set-maintenance",
      );

      const profile = await selectSshProfile({
        directory,
        env,
        remote: "git@relay-profile.invalid:repo",
        branch: "data",
      });

      expect(profile.command).toBeNull();
      expect(profile.capability).toMatchObject({ mode: "custom", source: "core.sshCommand" });
      expect(
        requireGit(
          await git(directory, ["config", "--local", "--get", "core.sshCommand"], { env }),
          "saved-ssh",
        ),
      ).toBe(custom);
      expect(
        requireGit(
          await git(directory, ["config", "--get", "gc.autoDetach"], { env }),
          "effective-maintenance",
        ),
      ).toBe("false");
      expect(
        requireGit(
          await git(directory, ["config", "--local", "--get", "gc.autoDetach"], { env }),
          "saved-maintenance",
        ),
      ).toBe("true");
    });
  }, 15_000);
});
