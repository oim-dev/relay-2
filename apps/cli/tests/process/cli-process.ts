import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { delimiter, dirname, join, resolve } from "node:path";
import { nativeExecutableName } from "@relay/project-runtime";
import type { BinaryOptions, BinaryResult } from "./cli-process.types";
import { fixtureProcessTree } from "./native/process-tree";

const binary = resolve(import.meta.dir, "../../dist", nativeExecutableName("relay"));
const artifacts = resolve(
  import.meta.dir,
  "../../../../.artifacts",
  new Date().toISOString().slice(0, 10),
);
const processDeadlineMs = 3000;

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
  const tree = fixtureProcessTree();
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
      detached: tree.detached,
    });
    child = running;
    deadline = setTimeout(() => {
      termination = tree.terminate(running.pid);
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
        await (termination ?? tree.terminate(child.pid));
        await child.exited;
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
}
