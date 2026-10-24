import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { delimiter, dirname, join, resolve } from "node:path";
import type { BinaryOptions, BinaryResult } from "./cli-process.types";

const binary = resolve(
  import.meta.dir,
  process.platform === "win32" ? "../../dist/relay.exe" : "../../dist/relay",
);
const artifacts = resolve(
  import.meta.dir,
  "../../../../.artifacts",
  new Date().toISOString().slice(0, 10),
);
const processDeadlineMs = 3000;

/**
 * Завершает принадлежащую fixture POSIX-группу либо Windows-дерево через native taskkill.
 * Исчезнувшая группа уже освобождена; остальные системные ошибки не скрываются.
 */
async function terminateProcessGroup(pid: number): Promise<void> {
  if (process.platform === "win32") {
    const killer = Bun.spawn(["taskkill.exe", "/PID", String(pid), "/T", "/F"], {
      stdout: "ignore",
      stderr: "ignore",
    });
    const code = await killer.exited;
    if (code !== 0 && code !== 128) {
      throw new Error(`taskkill завершился с кодом ${code}`);
    }
    return;
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) {
      throw error;
    }
  }
}

/**
 * Запускает бинарник или оболочку с изолированными HOME и cwd, читая реальные потоки.
 * PATH направляет вызов relay к проверяемому бинарнику. На POSIX отдельная группа процессов
 * ограничена тремя секундами; deadline и finally завершают всю группу и освобождают pipe.
 * finally также удаляет каталог. closeStdout закрывает настоящую принимающую сторону pipe.
 */
export async function invokeBinary(
  argv: readonly string[],
  options: BinaryOptions = {},
): Promise<BinaryResult> {
  const root = options.artifactGroup ? join(artifacts, options.artifactGroup) : artifacts;
  await mkdir(root, { recursive: true });
  const directory = await mkdtemp(join(root, "cli-process-"));
  let child: ReturnType<typeof Bun.spawn> | undefined;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  let termination: Promise<void> | undefined;
  try {
    await options.prepare?.(directory);
    const emptyStdin = options.openStdin ? "pipe" : "ignore";
    const input =
      typeof options.stdin === "string" ? new TextEncoder().encode(options.stdin) : options.stdin;
    const stdin = input ?? emptyStdin;
    const running = Bun.spawn([...(options.command ?? [binary]), ...argv], {
      cwd: directory,
      env: {
        HOME: directory,
        USERPROFILE: directory,
        RELAY_HOME: directory,
        PATH: `${dirname(binary)}${delimiter}${process.env.PATH ?? ""}`,
        ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
        ...(process.env.PATHEXT ? { PATHEXT: process.env.PATHEXT } : {}),
      },
      stdin,
      stdout: "pipe",
      stderr: "pipe",
      detached: process.platform !== "win32",
    });
    child = running;
    deadline = setTimeout(() => {
      termination = terminateProcessGroup(running.pid);
    }, processDeadlineMs);
    const [exitCode, stdout, stderr] = await Promise.all([
      running.exited,
      options.closeStdout
        ? running.stdout.cancel().then(() => "")
        : new Response(running.stdout).text(),
      new Response(running.stderr).text(),
    ]);
    return { exitCode, stdout, stderr, files: await readdir(directory) };
  } finally {
    clearTimeout(deadline);
    try {
      if (child) {
        await (termination ?? terminateProcessGroup(child.pid));
        await child.exited;
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
}
