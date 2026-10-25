import { homedir } from "node:os";
import { RelayError } from "@relay/contracts";
import manifest from "../../package.json";
import { parseInvocation } from "./arguments";
import { processMessages as messages } from "./process.messages";
import type { ServerEnvironment, ServerInvocation } from "./process.types";

/**
 * Записывает stdout с ожиданием flush перед process.exit.
 */
async function stdout(text: string): Promise<void> {
  await Bun.write(Bun.stdout, text);
}

/**
 * Владеет только своими signals/stdin listeners на время одного foreground запуска.
 */
async function runForeground(
  invocation: ServerInvocation,
  environment: ServerEnvironment,
): Promise<void> {
  const controller = new AbortController();
  /**
   * Идемпотентно объединяет сигналы ОС, потерю stdin lease и Runtime control.
   */
  const stop = (): void => controller.abort();
  const lease = invocation.kind === "launch" && invocation.parentLease;
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  if (lease) {
    process.stdin.once("end", stop);
    process.stdin.once("error", stop);
    process.stdin.resume();
    if (process.stdin.readableEnded) {
      stop();
    }
  }
  try {
    const { bootstrapServer } = await import("./bootstrap");
    await bootstrapServer(
      invocation,
      environment,
      { signal: controller.signal, stop, stdout },
      manifest.version,
    );
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    if (lease) {
      process.stdin.off("end", stop);
      process.stdin.off("error", stop);
      process.stdin.pause();
    }
  }
}

/**
 * Единственная граница чтения глобальной среды. Help/version не импортируют HTTP/SQLite/assets.
 */
export async function runServerProcess(argv: readonly string[]): Promise<number> {
  try {
    const env = { ...process.env };
    const environment: ServerEnvironment = {
      cwd: process.cwd(),
      env,
      executablePath: process.execPath,
      userHome: env.HOME ?? env.USERPROFILE ?? homedir(),
      standalone: Bun.isStandaloneExecutable,
    };
    const invocation = parseInvocation(argv, environment);
    if (invocation.kind === "help") {
      await stdout(messages.help);
    } else if (invocation.kind === "version") {
      await stdout(`relay-server ${manifest.version}\n`);
    } else {
      await runForeground(invocation, environment);
    }
    return 0;
  } catch (cause) {
    if (cause instanceof Error && "code" in cause && cause.code === "EPIPE") {
      return 0;
    }
    const error =
      cause instanceof RelayError
        ? cause
        : new RelayError("SERVER_FAILED", messages.failed, 1, {
            reason: cause instanceof Error ? cause.message : String(cause),
          });
    try {
      await Bun.write(
        Bun.stderr,
        `${JSON.stringify({ ok: false, error: { code: error.code, message: error.message, ...(error.details === undefined ? {} : { details: error.details }) } })}\n`,
      );
    } catch {
      return error.exitCode || 1;
    }
    return error.exitCode;
  }
}
