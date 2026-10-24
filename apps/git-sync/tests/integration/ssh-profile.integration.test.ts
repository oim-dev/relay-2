import { describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { git, requireGit } from "../../src/transport/git";
import { redact, runProcess } from "../../src/transport/process";
import type { ProcessInput, ProcessResult } from "../../src/transport/process.types";
import { probeSsh, selectSshProfile, shellWord } from "../../src/transport/ssh-profile";

const modernClients = [
  {
    name: "MSYS OpenSSH из Windows CI",
    executable: "C:\\Program Files\\Git\\usr\\bin\\ssh.exe",
    stderr: "OpenSSH_10.5p1, OpenSSL 3.5.9 29 Sep 2026\n",
    implementation: "OpenSSH_10.5p1",
  },
  {
    name: "native Windows OpenSSH",
    executable: "C:\\Windows\\System32\\OpenSSH\\ssh.exe",
    stderr: "OpenSSH_for_Windows_9.5p1, LibreSSL 3.8.2\r\n",
    implementation: "OpenSSH_for_Windows_9.5p1",
  },
];

/**
 * Владеет отдельным каталогом и файлами настроек под artifacts, удаляет их после callback при любом исходе.
 */
async function withSshDirectory(
  operation: (directory: string, env: Record<string, string | undefined>) => Promise<void>,
): Promise<void> {
  const parent = fileURLToPath(
    new URL(
      `../../../../.artifacts/${new Date().toISOString().slice(0, 10)}/git-sync-implementation/git-sync/ssh-fixtures/`,
      import.meta.url,
    ),
  );
  mkdirSync(parent, { recursive: true });
  const directory = mkdtempSync(join(parent, "SSH профиль 'с пробелом'-"));
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
    await operation(directory, env);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

/**
 * Подготавливает bare Git в собственном каталоге; предметная БД и пользовательский SSH config не нужны.
 */
async function withSshRepository(
  operation: (directory: string, env: Record<string, string | undefined>) => Promise<void>,
): Promise<void> {
  await withSshDirectory(async (directory, env) => {
    requireGit(await git(directory, ["init", "--bare", "."], { env }), "init");
    await operation(directory, env);
  });
}

/**
 * Проверяет, что -G читает реальный пустой файл внутри отдельного каталога probe, а не null device.
 */
function expectEmptyProbeConfiguration(command: ProcessInput, directory: string): string {
  expect(command.args[0]).toBe("-G");
  expect(command.args[1]).toBe("-F");
  const configuration = command.args[2];
  if (configuration === undefined) {
    throw new Error("Путь пустого probe config отсутствует");
  }
  expect(isAbsolute(configuration)).toBe(true);
  expect(dirname(dirname(configuration))).toBe(directory);
  expect(statSync(configuration).isFile()).toBe(true);
  expect(readFileSync(configuration, "utf8")).toBe("");
  return configuration;
}

/**
 * Создаёт ответ контролируемого исполнителя; файловый lifetime проверяется настоящей файловой системой.
 */
function result(exitCode: number, stdout = "", stderr = ""): ProcessResult {
  return { exitCode, stdout: Buffer.from(stdout), stderr: Buffer.from(stderr) };
}

/**
 * При отказе профиля повторяет только безопасный production probe в том же Git окружении.
 * Печатает короткие version/exit/stderr, не меняя исходный assert и выбор SSH клиента.
 */
async function printSshProbeFailure(
  directory: string,
  env: Record<string, string | undefined>,
): Promise<void> {
  const entry = fileURLToPath(new URL("./helpers/ssh-profile-diagnostic.ts", import.meta.url));
  const command = [process.execPath, entry].map((word) => shellWord(word)).join(" ");
  try {
    const diagnostic = await git(
      directory,
      ["-c", `alias.relay-test-ssh-diagnostic=!${command}`, "relay-test-ssh-diagnostic"],
      { env, timeoutMs: 10_000, maxBytes: 16 * 1024 },
    );
    console.error("Диагностика SSH probe:", {
      exitCode: diagnostic.exitCode,
      stdout: redact(diagnostic.stdout.toString("utf8")),
      stderr: redact(diagnostic.stderr.toString("utf8")),
    });
  } catch (error) {
    console.error("Диагностика SSH probe недоступна:", redact(String(error)));
  }
}

describe("SSH profile в настоящем Git окружении", () => {
  test.skipIf(Bun.which("ssh") === null)(
    "probe stdout отделён от протокола, identity/proxy и ControlMaster сохраняются",
    async () => {
      await withSshRepository(async (directory, env) => {
        const before = readdirSync(directory);
        const profile = await selectSshProfile({
          directory,
          env,
          remote: "ssh://relay-profile.invalid/repo",
          branch: "data",
        });
        if (profile.capability.mode !== "openssh-foreground") {
          console.error("Неожиданный SSH профиль:", profile.capability);
          await printSshProbeFailure(directory, env);
        }
        expect(profile.capability.mode).toBe("openssh-foreground");
        expect(profile.command).not.toBeNull();
        expect(profile.command).not.toContain(" -F");
        expect(readdirSync(directory)).toEqual(before);
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

describe("Переносимый SSH probe и владение пустым config", () => {
  test("старый OpenSSH получает только поддержанный ControlPersist; частичный отказ очищает config", async () => {
    await withSshDirectory(async (directory) => {
      const before = readdirSync(directory);
      const calls: ProcessInput[] = [];

      const probe = await probeSsh(
        { executable: "/fixture/ssh", cwd: directory },
        async (command) => {
          calls.push(command);
          if (command.args[0] === "-V") {
            return result(0, "OpenSSH_7.9p1 fixture\n");
          }
          expectEmptyProbeConfiguration(command, directory);
          if (command.args.includes("ForkAfterAuthentication=no")) {
            return result(
              255,
              "",
              "command-line: line 0: Bad configuration option: forkafterauthentication",
            );
          }
          return result(0, "controlpersist no\n");
        },
      );

      expect(probe).toMatchObject({
        implementation: "OpenSSH_7.9p1",
        options: ["ControlPersist=no"],
      });
      expect(
        calls.every((command) => command.timeoutMs === 3000 && command.maxBytes === 65536),
      ).toBe(true);
      expect(readdirSync(directory)).toEqual(before);
    });
  });

  test.each(modernClients)(
    "$name: версия из stderr распознаётся, -G stdout остаётся диагностикой",
    async (client) => {
      await withSshDirectory(async (directory) => {
        const before = readdirSync(directory);

        const probe = await probeSsh(
          { executable: client.executable, cwd: directory },
          async (command) => {
            if (command.args[0] === "-V") {
              return result(0, "", client.stderr);
            }
            expectEmptyProbeConfiguration(command, directory);
            return result(0, "identityfile user-key\nproxycommand ssh -W %h:%p gateway\n");
          },
        );

        expect(probe).toEqual({
          executable: client.executable,
          implementation: client.implementation,
          options: ["ForkAfterAuthentication=no", "ControlPersist=no"],
        });
        expect(readdirSync(directory)).toEqual(before);
      });
    },
  );

  test.skipIf(Bun.which("ssh") === null)(
    "настоящий SSH читает owned пустой файл с Unicode/пробелами и сохраняет соседний config",
    async () => {
      await withSshDirectory(async (directory, env) => {
        const occupied = join(directory, ".relay-ssh-probe-existing");
        mkdirSync(occupied);
        const userConfig = join(occupied, "empty.conf");
        writeFileSync(userConfig, "Конфигурация другого владельца", { flag: "wx" });
        const before = readdirSync(directory);
        const configurations: string[] = [];

        const probe = await probeSsh(
          { executable: Bun.which("ssh"), cwd: directory },
          async (command) => {
            if (command.args[0] === "-G") {
              configurations.push(expectEmptyProbeConfiguration(command, directory));
            }
            return runProcess({ ...command, env });
          },
        );

        expect(probe.options).toContain("ControlPersist=no");
        expect(configurations).toHaveLength(2);
        expect(configurations[0]).toBe(configurations[1]);
        expect(readFileSync(userConfig, "utf8")).toBe("Конфигурация другого владельца");
        expect(readdirSync(directory)).toEqual(before);
      });
    },
    15_000,
  );

  test("исключение исполнителя удаляет owned config и сохраняет исходную ошибку", async () => {
    await withSshDirectory(async (directory) => {
      const before = readdirSync(directory);
      const failure = new Error("Остановка probe исполнителем");

      await expect(
        probeSsh({ executable: "/fixture/ssh", cwd: directory }, async (command) => {
          if (command.args[0] === "-V") {
            return result(0, "", "OpenSSH_10.5p1\n");
          }
          expectEmptyProbeConfiguration(command, directory);
          throw failure;
        }),
      ).rejects.toBe(failure);

      expect(readdirSync(directory)).toEqual(before);
    });
  });
});
