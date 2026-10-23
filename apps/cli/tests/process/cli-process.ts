import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { BinaryOptions, BinaryResult } from "./cli-process.types";

const binary = resolve(import.meta.dir, "../../dist/relay");
const artifacts = resolve(
  import.meta.dir,
  "../../../../.artifacts",
  new Date().toISOString().slice(0, 10),
);
const processDeadlineMs = 3000;

/**
 * Завершает принадлежащую fixture POSIX-группу, включая потомков уже завершившегося Bash.
 * Исчезнувшая группа уже освобождена; остальные системные ошибки не скрываются.
 */
function terminateProcessGroup(pid: number): void {
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
  try {
    options.prepare?.(directory);
    const emptyStdin = options.openStdin ? "pipe" : "ignore";
    const input =
      typeof options.stdin === "string" ? new TextEncoder().encode(options.stdin) : options.stdin;
    const stdin = input ?? emptyStdin;
    const running = Bun.spawn([...(options.command ?? [binary]), ...argv], {
      cwd: directory,
      env: {
        HOME: directory,
        RELAY_HOME: directory,
        PATH: `${dirname(binary)}:${process.env.PATH ?? ""}`,
      },
      stdin,
      stdout: "pipe",
      stderr: "pipe",
      detached: true,
    });
    child = running;
    deadline = setTimeout(() => terminateProcessGroup(running.pid), processDeadlineMs);
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
        terminateProcessGroup(child.pid);
        await child.exited;
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
}
