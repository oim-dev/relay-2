import { spawn, type ChildProcess } from "node:child_process";
import { constants } from "node:os";
import { terminateCommandGroup } from "./posix-group";
import { spawnDiagnostic } from "./diagnostics";
import type { AnchorOutcome, GuardianRequest } from "./protocol.types";

/**
 * Сообщает exit непосредственной команды, сохраняя живой якорь до очистки контейнера.
 */
function reportOutcome(outcome: AnchorOutcome): void {
  process.send?.(outcome, () => {});
}

/**
 * Запускает команду лишь после назначения якоря в контейнер. Raw output наследуется напрямую.
 * fixed input заканчивается EOF; stdinLease остаётся открытым до graceful stop.
 * После команды якорь живёт до обязательного force cleanup всех принадлежащих ему процессов.
 */
export function runCommandAnchor(
  request: GuardianRequest,
  lease: AbortSignal,
  control: AbortSignal,
): Promise<number> {
  return new Promise((resolve) => {
    let child: ChildProcess | undefined;
    let commandEnded = false;

    /**
     * Потеря guardian не оставляет обычную POSIX-группу без владельца.
     */
    function ownerLost(): void {
      if (process.platform !== "win32") {
        try {
          terminateCommandGroup(process.pid);
        } catch {
          // Нарушенное владение не превращается в успешный исход служебной роли.
        }
      }
      resolve(1);
    }

    /**
     * Закрывает stdin lease и передаёт graceful-сигнал; force cleanup остаётся у guardian.
     */
    function controlledStop(): void {
      const signal = control.reason === "SIGINT" ? "SIGINT" : "SIGTERM";
      if (control.reason === "stdin-eof") {
        child?.stdin?.end();
        return;
      }
      if (process.platform !== "win32") {
        try {
          process.kill(-process.pid, signal);
        } catch {
          ownerLost();
        }
      } else if (request.stdinLease) {
        child?.stdin?.end();
      } else if (child && !commandEnded) {
        child.kill(signal);
      }
    }

    lease.addEventListener("abort", ownerLost, { once: true });
    control.addEventListener("abort", controlledStop, { once: true });
    if (lease.aborted || control.aborted) {
      ownerLost();
      return;
    }
    const [executable, ...args] = request.argv;
    if (!executable) {
      reportOutcome({ version: 1, kind: "failure", reason: "protocol" });
      return;
    }
    try {
      child = spawn(executable, args, {
        cwd: request.cwd,
        env: request.env,
        stdio: ["pipe", "inherit", "inherit"],
        windowsHide: true,
      });
      child.once("error", (cause) => {
        commandEnded = true;
        reportOutcome({
          version: 1,
          kind: "failure",
          reason: "spawn",
          ...spawnDiagnostic("command-spawn", cause),
        });
      });
      child.once("exit", (code, signal) => {
        commandEnded = true;
        reportOutcome({
          version: 1,
          kind: "result",
          code: code ?? 128 + (signal ? constants.signals[signal] : 0),
        });
      });
      child.stdin?.on("error", (error: unknown) => {
        if (
          error instanceof Error &&
          "code" in error &&
          (error.code === "EPIPE" || error.code === "ERR_STREAM_DESTROYED")
        ) {
          return;
        }
        process.send?.({ version: 1, kind: "failure", reason: "guardian" }, () => {});
      });
      const input = Buffer.from(request.input, "base64");
      if (request.stdinLease) {
        child.stdin?.write(input);
      } else {
        child.stdin?.end(input);
      }
    } catch (cause) {
      commandEnded = true;
      reportOutcome({
        version: 1,
        kind: "failure",
        reason: "spawn",
        ...spawnDiagnostic("command-spawn", cause),
      });
    }
  });
}
