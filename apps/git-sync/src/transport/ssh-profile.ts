import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gitCommand, checkGit } from "./git";
import { componentCommand } from "./component-command";
import { runProcess } from "./process";
import type {
  ProcessExecutor,
  SshCapability,
  SshProbe,
  SshProbeContext,
  SshProfile,
} from "./ssh-profile.types";
import type { RepositoryOptions } from "./repository.types";
import { invalidSnapshot, keys, object, text, array } from "../snapshot/json";

const FOREGROUND_OPTIONS = ["ForkAfterAuthentication=no", "ControlPersist=no"] as const;

/**
 * Отличает стандартные SSH URL/scp формы от HTTP и локальных файловых remote.
 */
export function usesSsh(remote: string, platform: string = process.platform): boolean {
  if (platform === "win32" && /^[a-z]:/i.test(remote)) {
    return false;
  }
  if (/^ssh:\/\//i.test(remote)) {
    return true;
  }
  return !/^[a-z][a-z0-9+.-]*:\/\//i.test(remote) && /^[^/\\:]+(?:@[^/\\:]+)?:[^/\\]/.test(remote);
}

/**
 * Кодирует только контролируемые argv в Git shell: Git for Windows также использует sh для alias/sshCommand.
 */
export function shellWord(value: string, platform: string = process.platform): string {
  const word = platform === "win32" ? value.replaceAll("\\", "/") : value;
  return `'${word.replaceAll("'", "'\\''")}'`;
}

/**
 * Проверяет известный default SSH внутри Git окружения; -G с собственным пустым -F исключает сеть и Match exec.
 * После распознавания версии создаёт отдельный каталог в cwd и удаляет его в finally, включая отказ runner.
 * Обычный файл переносим между native Windows и MSYS OpenSSH, в отличие от NUL или /dev/null.
 * Старому клиенту неподдерживаемый ForkAfterAuthentication не передаётся в реальном соединении.
 */
export async function probeSsh(context: SshProbeContext, run: ProcessExecutor): Promise<SshProbe> {
  const executable = context.executable;
  if (executable === null) {
    return { executable: null, implementation: null, options: [] };
  }
  const options = { executable, cwd: context.cwd, timeoutMs: 3000, maxBytes: 64 * 1024 };
  const version = await run({ ...options, args: ["-V"] });
  const banner = /(?:^|\n)(OpenSSH_[^\s,]+)/.exec(
    version.stderr.toString("utf8") + "\n" + version.stdout.toString("utf8"),
  )?.[1];
  if (version.exitCode !== 0 || !banner) {
    return { executable, implementation: null, options: [] };
  }
  const directory = mkdtempSync(join(context.cwd, ".relay-ssh-probe-"));
  try {
    const configuration = join(directory, "empty.conf");
    writeFileSync(configuration, "", { flag: "wx", mode: 0o600 });
    const supported: string[] = [];
    for (const option of FOREGROUND_OPTIONS) {
      const probe = await run({
        ...options,
        args: ["-G", "-F", configuration, "-o", option, "relay-ssh-profile.invalid"],
      });
      if (probe.exitCode === 0) {
        supported.push(option);
      }
    }
    return { executable, implementation: banner, options: supported };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

/**
 * Приватный entrypoint вызывается Git alias и разрешает ssh именно из переданного Git PATH.
 */
export function probeDefaultSsh(): Promise<SshProbe> {
  return probeSsh({ executable: Bun.which("ssh"), cwd: process.cwd() }, runProcess);
}

/**
 * Читает только версионированный приватный результат probe, не произвольную shell-команду.
 */
function decodeProbe(value: unknown): SshProbe {
  const probe = object(value);
  keys(probe, ["executable", "implementation", "options"]);
  const options = array(probe.options).map(text);
  if (options.some((option) => !FOREGROUND_OPTIONS.some((allowed) => allowed === option))) {
    invalidSnapshot();
  }
  return {
    executable: probe.executable === null ? null : text(probe.executable),
    implementation: probe.implementation === null ? null : text(probe.implementation),
    options,
  };
}

/**
 * Отмечает пользовательский транспорт, сохраняя исходный выбор Git и все его аргументы дословно.
 */
function custom(source: SshCapability["source"]): SshProfile {
  return {
    command: null,
    capability: { mode: "custom", source, implementation: null, options: [] },
  };
}

/**
 * Выбирает профиль без изменения global config. Default ssh ищется самим Git через scoped alias,
 * поэтому bundled Git for Windows PATH и обычный PATH не подменяют друг друга.
 * Кеш default probe принадлежит экземпляру repo; effective custom settings проверяются при каждой попытке.
 */
export async function selectSshProfile(
  options: RepositoryOptions,
  cached?: SshProfile,
  run: ProcessExecutor = runProcess,
  component: readonly string[] = componentCommand([]),
): Promise<SshProfile> {
  if (!usesSsh(options.remote)) {
    return {
      command: null,
      capability: { mode: "not-used", source: null, implementation: null, options: [] },
    };
  }
  const env = { ...process.env, ...options.env };
  for (const source of ["GIT_SSH_COMMAND", "GIT_SSH", "GIT_SSH_VARIANT"] as const) {
    if (env[source] !== undefined) {
      return custom(source);
    }
  }
  const execution = {
    ...(options.env ? { env: options.env } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
  };
  const config = await run(
    gitCommand(
      options.directory,
      ["config", "--null", "--get-regexp", "^(core\\.sshcommand|ssh\\.variant)$"],
      execution,
    ),
  );
  if (config.exitCode !== 0 && config.exitCode !== 1) {
    checkGit(config, "ssh-config");
  }
  for (const entry of config.stdout.toString("utf8").split("\0")) {
    const key = entry.split("\n", 1)[0]?.toLowerCase();
    if (key === "core.sshcommand") {
      return custom("core.sshCommand");
    }
    if (key === "ssh.variant") {
      return custom("ssh.variant");
    }
  }
  if (cached?.capability.source === "default") {
    return cached;
  }
  const alias = "!" + [...component, "--ssh-profile"].map((word) => shellWord(word)).join(" ");
  const result = await run(
    gitCommand(
      options.directory,
      ["-c", `alias.relay-internal-ssh-profile=${alias}`, "relay-internal-ssh-profile"],
      execution,
    ),
  );
  checkGit(result, "ssh-profile");
  const probe = decodeProbe(JSON.parse(result.stdout.toString("utf8")));
  if (
    probe.executable === null ||
    probe.implementation === null ||
    !probe.options.includes("ControlPersist=no")
  ) {
    return {
      command: null,
      capability: {
        mode: "unverified",
        source: "default",
        implementation: probe.implementation,
        options: [],
      },
    };
  }
  const command = [
    shellWord(probe.executable),
    ...probe.options.flatMap((option) => ["-o", shellWord(option)]),
  ].join(" ");
  return {
    command,
    capability: {
      mode: "openssh-foreground",
      source: "default",
      implementation: probe.implementation,
      options: probe.options,
    },
  };
}
