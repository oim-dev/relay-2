import { spawn } from "node:child_process";
import { GuardedCommandError } from "./errors";
import { spawnDiagnostic } from "./diagnostics";
import { encodeFrame, FrameDecoder } from "./frame";
import type { GuardedCommandOptions, GuardedCommandResult } from "./guardian.types";
import {
  createRequest,
  decodeOutput,
  decodeResponse,
  guardianGraceMs,
  responseFrameLimit,
  treeCleanupMs,
} from "./protocol";

/* Диагностика самого helper не смешивается с бюджетом исходной команды. */
const maxGuardianStderrBytes = 8192;

/**
 * Запускает явно доверенный helper и удерживает его stdin lease до конца операции.
 * Deadline, бюджет и контейнер принадлежат helper; его собственный отказ тоже имеет
 * ограниченный drain. Compiled приложение обязано реализовать private --guarded-command.
 * Ненулевой code команды возвращается результатом, инфраструктура — GuardedCommandError.
 */
export function runGuardedCommand(options: GuardedCommandOptions): Promise<GuardedCommandResult> {
  if (options.signal?.aborted) {
    return Promise.reject(new GuardedCommandError("cancelled"));
  }
  try {
    const request = createRequest(options);
    const frame = encodeFrame(request);
    const [executable, ...args] = options.component;
    if (!executable) {
      throw new GuardedCommandError("protocol");
    }
    const child = spawn(executable, [...args, "--guarded-command"], {
      stdio: ["pipe", "pipe", "pipe", "ipc"],
      detached: true,
      windowsHide: true,
      serialization: "json",
    });
    if (!child.stdin || !child.stdout || !child.stderr) {
      child.kill("SIGKILL");
      throw new GuardedCommandError("spawn");
    }
    const stdin = child.stdin;
    const stdout = child.stdout;
    const stderr = child.stderr;
    return new Promise((resolve, reject) => {
      const decoder = new FrameDecoder(responseFrameLimit(options.maxOutputBytes));
      const diagnostics: Buffer[] = [];
      let diagnosticSize = 0;
      let failure: GuardedCommandError | undefined;
      let settled = false;
      let ready = false;
      let stopSent = false;
      let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
      let exitDrainTimer: ReturnType<typeof setTimeout> | undefined;
      let watchdogGrace: ReturnType<typeof setTimeout> | undefined;
      const handshake = setTimeout(
        () => fail(new GuardedCommandError("guardian")),
        guardianGraceMs,
      );
      // Grace отдельным timer: сумма с максимальным timeoutMs не переполняет диапазон setTimeout.
      const watchdog =
        request.timeoutMs === null
          ? undefined
          : setTimeout(() => {
              watchdogGrace = setTimeout(
                () => fail(new GuardedCommandError("guardian")),
                guardianGraceMs + request.terminationGraceMs,
              );
            }, request.timeoutMs);

      /**
       * Завершает ожидание ровно один раз, закрывая собственные pipe даже при живом чужом fd.
       */
      function finish(code: number | null, forced = false): void {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(handshake);
        clearTimeout(watchdog);
        clearTimeout(watchdogGrace);
        clearTimeout(cleanupTimer);
        clearTimeout(exitDrainTimer);
        options.signal?.removeEventListener("abort", cancel);
        stdin.destroy();
        stdout.destroy();
        stderr.destroy();
        if (child.connected) {
          child.disconnect();
        }
        if (forced && child.exitCode === null && child.signalCode === null) {
          child.kill("SIGKILL");
        }
        child.unref();
        try {
          if (failure) {
            throw failure;
          }
          if (code !== 0) {
            throw new GuardedCommandError("guardian", {
              stderr: Buffer.concat(diagnostics).toString("utf8"),
            });
          }
          const response = decodeResponse(decoder.value(), request);
          const result = {
            stdout: Buffer.from(response.stdout, "base64"),
            stderr: Buffer.from(response.stderr, "base64").toString("utf8"),
          };
          if (response.kind === "failure") {
            throw new GuardedCommandError(response.reason, {
              ...result,
              ...(response.stage === undefined ? {} : { stage: response.stage }),
              ...(response.systemCode === undefined ? {} : { systemCode: response.systemCode }),
            });
          }
          if (!ready) {
            throw new GuardedCommandError("guardian");
          }
          resolve({ code: response.code, ...result });
        } catch (error) {
          reject(error);
        }
      }

      /**
       * Передаёт сигнал после ready, когда helper уже установил control listener.
       */
      function sendStop(): void {
        const signal = options.signal?.reason === "SIGINT" ? "SIGINT" : "SIGTERM";
        if (child.connected) {
          child.send({ version: 1, kind: "stop", signal }, (error) => {
            if (error) {
              stdin.end();
            }
          });
        } else {
          stdin.end();
        }
      }

      /**
       * Ограничивает остановку; ранний AbortSignal ждёт ready, не подменяя SIGTERM событием EOF.
       * При нарушении самого helper его lease закрывается сразу.
       */
      function stop(): void {
        if (settled || stopSent) {
          return;
        }
        stopSent = true;
        if (ready) {
          sendStop();
        } else if (failure) {
          stdin.end();
        }
        cleanupTimer = setTimeout(
          () => {
            failure ??= new GuardedCommandError("cleanup");
            finish(null, true);
          },
          request.terminationGraceMs + treeCleanupMs + 1000,
        );
      }

      /**
       * Сохраняет локальную причину и ждёт ограниченную очистку доверенного helper.
       */
      function fail(error: GuardedCommandError): void {
        if (settled) {
          return;
        }
        failure ??= error;
        if (stopSent && !ready) {
          stdin.end();
        }
        stop();
      }

      /**
       * SIGINT/SIGTERM передаются отдельно от EOF; внезапная смерть владельца всё равно закрывает lease.
       */
      function cancel(): void {
        stop();
      }

      options.signal?.addEventListener("abort", cancel, { once: true });
      child.on("message", (value: unknown) => {
        if (settled || failure) {
          return;
        }
        try {
          if (
            value !== null &&
            typeof value === "object" &&
            !Array.isArray(value) &&
            "version" in value &&
            value.version === 1 &&
            "kind" in value &&
            value.kind === "ready" &&
            Object.keys(value).length === 2
          ) {
            if (ready) {
              throw new GuardedCommandError("protocol");
            }
            ready = true;
            clearTimeout(handshake);
            if (stopSent) {
              sendStop();
            }
            return;
          }
          const output = decodeOutput(value);
          const write = output.stream === "stdout" ? options.stdout : options.stderr;
          if (!ready || !write) {
            throw new GuardedCommandError("protocol");
          }
          write(Buffer.from(output.data, "base64"));
        } catch (cause) {
          fail(
            cause instanceof GuardedCommandError
              ? cause
              : new GuardedCommandError("protocol", { cause }),
          );
        }
      });
      stdout.on("data", (chunk: Buffer) => {
        if (settled || failure) {
          return;
        }
        try {
          decoder.push(chunk);
        } catch (cause) {
          fail(new GuardedCommandError("protocol", { cause }));
        }
      });
      stderr.on("data", (chunk: Buffer) => {
        const accepted = Buffer.from(
          chunk.subarray(0, Math.max(0, maxGuardianStderrBytes - diagnosticSize)),
        );
        if (accepted.length > 0) {
          diagnostics.push(accepted);
          diagnosticSize += accepted.length;
        }
      });
      stdin.on("error", (cause) => fail(new GuardedCommandError("guardian", { cause })));
      child.once("error", (cause) =>
        fail(new GuardedCommandError("spawn", spawnDiagnostic("guardian-spawn", cause))),
      );
      child.once("exit", () => {
        // SIGKILL из finish может завершиться позже самого Promise; новый timer уже не нужен.
        if (settled) {
          return;
        }
        exitDrainTimer = setTimeout(() => {
          failure ??= new GuardedCommandError("guardian");
          finish(null, true);
        }, treeCleanupMs);
      });
      child.once("close", (code) => finish(code));
      stdin.write(frame);
      if (options.signal?.aborted) {
        cancel();
      }
    });
  } catch (cause) {
    return Promise.reject(
      cause instanceof GuardedCommandError
        ? cause
        : new GuardedCommandError("spawn", spawnDiagnostic("guardian-spawn", cause)),
    );
  }
}
