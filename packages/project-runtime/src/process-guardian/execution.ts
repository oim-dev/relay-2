import { spawn, type ChildProcess } from "node:child_process";
import { GuardedCommandError } from "./errors";
import { spawnDiagnostic } from "./diagnostics";
import { writeFrame } from "./frame";
import type { GuardedCommandDiagnostic, GuardedCommandFailureReason } from "./guardian.types";
import { CommandOutput } from "./output";
import { decodeOutcome, failureReason, treeCleanupMs } from "./protocol";
import type { AnchorOutcome, GuardianRequest, GuardianResponse } from "./protocol.types";
import { nativeProcessLifetime } from "../native/process-lifetime/select";
import type { CommandTree } from "./tree.types";

/**
 * Независимый владелец deadline, потоков и контейнера одной команды.
 * Любой exit команды завершает её контейнер; постоянные процессы создаёт независимый broker.
 */
class GuardianExecution {
  /* Проверенная команда. */
  private readonly request: GuardianRequest;
  /* EOF владельца или явная отмена с причиной сигнала. */
  private readonly cancellation: AbortSignal;
  /* Живой якорь до force cleanup. */
  private readonly child: ChildProcess;
  /* Контейнер установлен до отправки разрешающего frame якорю. */
  private tree: CommandTree | undefined;
  /* Первый результат команды либо первая причина отказа. */
  private outcome: AnchorOutcome | undefined;
  /* Ограниченный raw output и потоковая передача. */
  private readonly output: CommandOutput;
  /* Завершение двух читателей; не подменяет выход непосредственного процесса. */
  private readonly drained: Promise<void>;
  /* Подтверждение закрытия якоря. */
  private readonly closed = Promise.withResolvers<void>();
  /* Ограниченное завершение всего сценария, независимо от inherited pipes. */
  private readonly finished = Promise.withResolvers<void>();
  /* Начата graceful/force остановка. */
  private stopping = false;
  /* Force запускается однократно. */
  private forced = false;
  /* Завершение native cleanup. */
  private cleanup: Promise<void> = Promise.resolve();
  /* Native библиотека не закрывается раньше завершения её cleanup. */
  private cleanupEnded = true;
  /* Ограниченная graceful-фаза. */
  private graceTimer: ReturnType<typeof setTimeout> | undefined;
  /* Ограниченный force/drain этап. */
  private cleanupTimer: ReturnType<typeof setTimeout> | undefined;

  /**
   * Создаёт ожидающий конфигурацию якорь и немедленно читает оба выходных pipe.
   */
  constructor(request: GuardianRequest, cancellation: AbortSignal) {
    this.request = request;
    this.cancellation = cancellation;
    const [executable, ...args] = request.component;
    if (!executable) {
      throw new GuardedCommandError("protocol");
    }
    this.child = spawn(executable, [...args, "--guarded-command"], {
      stdio: ["pipe", "pipe", "pipe", "ipc"],
      ...nativeProcessLifetime().guardianSpawn,
      serialization: "json",
    });
    this.output = new CommandOutput(request, cancellation, (reason) => this.fail(reason));
    this.drained = Promise.all([
      this.child.stdout ? this.output.read(this.child.stdout, "stdout") : Promise.resolve(),
      this.child.stderr ? this.output.read(this.child.stderr, "stderr") : Promise.resolve(),
    ]).then(() => undefined);
    this.child.stdin?.on("error", () => this.fail("guardian"));
    this.child.on("message", (value: unknown) => this.receiveOutcome(value));
    this.child.once("error", (cause) => this.fail("spawn", spawnDiagnostic("anchor-spawn", cause)));
    this.child.once("exit", () => {
      if (!this.stopping) {
        this.fail("guardian");
      }
    });
    this.child.once("close", () => this.closed.resolve());
  }

  /**
   * Устанавливает контейнер до команды, затем ждёт ограниченный cleanup и drain.
   */
  async run(): Promise<GuardianResponse> {
    const timer =
      this.request.timeoutMs === null
        ? undefined
        : setTimeout(() => this.fail("timeout"), this.request.timeoutMs);
    /**
     * Сохраняет причину отмены; исходный сигнал передаётся якорю отдельно от reason ошибки.
     */
    const cancel = (): void =>
      this.fail(failureReason(this.cancellation.reason) ? this.cancellation.reason : "cancelled");
    this.cancellation.addEventListener("abort", cancel, { once: true });
    try {
      if (this.cancellation.aborted) {
        cancel();
      } else {
        this.startAnchor();
      }
      await this.finished.promise;
    } finally {
      clearTimeout(timer);
      clearTimeout(this.graceTimer);
      clearTimeout(this.cleanupTimer);
      this.cancellation.removeEventListener("abort", cancel);
      if (this.cleanupEnded) {
        this.disposeTree();
      } else {
        void this.cleanup.finally(() => this.disposeTree());
      }
    }
    return {
      ...(this.outcome ?? { version: 1, kind: "failure", reason: "guardian" }),
      stdout: this.output.bytes("stdout").toString("base64"),
      stderr: this.output.bytes("stderr").toString("base64"),
    };
  }

  /**
   * Назначает job/subreaper прежде, чем якорь сможет породить пользовательскую команду.
   */
  private startAnchor(): void {
    try {
      if (this.child.pid === undefined || !this.child.stdin) {
        this.fail("spawn");
        return;
      }
      this.tree = nativeProcessLifetime().ownTree(this.child.pid);
      void writeFrame(this.child.stdin, { ...this.request, role: "anchor" }).catch(() =>
        this.fail("guardian"),
      );
    } catch (error) {
      this.fail(
        error instanceof GuardedCommandError ? error.reason : "spawn",
        spawnDiagnostic("container-setup", error),
      );
    }
  }

  /**
   * Exit команды отделён от drain и всегда запускает очистку оставшихся потомков.
   */
  private receiveOutcome(value: unknown): void {
    try {
      const outcome = decodeOutcome(value);
      if (this.outcome === undefined) {
        this.outcome = outcome;
        this.stop();
      } else if (this.stopping) {
        this.force();
      }
    } catch {
      this.fail("protocol");
    }
  }

  /**
   * Сохраняет первый отказ; result не скрывает отказ чтения/декодирования во время drain.
   */
  private fail(reason: GuardedCommandFailureReason, diagnostic?: GuardedCommandDiagnostic): void {
    if (this.outcome?.kind !== "failure") {
      this.outcome = { version: 1, kind: "failure", reason, ...diagnostic };
    } else if (
      diagnostic &&
      this.outcome.reason === reason &&
      this.outcome.systemCode === undefined &&
      (this.outcome.stage === undefined || this.outcome.stage === diagnostic.stage)
    ) {
      this.outcome = { ...this.outcome, ...diagnostic };
    }
    this.stop();
  }

  /**
   * Сначала даёт команде ограниченную graceful-фазу; обычный exit очищает контейнер сразу.
   */
  private stop(): void {
    if (this.stopping) {
      return;
    }
    this.stopping = true;
    if (
      this.outcome?.kind === "failure" &&
      this.tree &&
      this.child.connected &&
      this.request.terminationGraceMs > 0
    ) {
      const signal = this.cancellation.reason === "SIGINT" ? "SIGINT" : "SIGTERM";
      const stdinOnly =
        this.request.stdinLease &&
        this.cancellation.reason !== "SIGTERM" &&
        this.cancellation.reason !== "SIGINT" &&
        (this.outcome.reason === "cancelled" || this.cancellation.reason === "stdin-eof");
      this.child.send({ version: 1, kind: "stop", signal, stdinOnly }, () => {});
      this.graceTimer = setTimeout(() => this.force(), this.request.terminationGraceMs);
    } else {
      this.force();
    }
  }

  /**
   * Принудительно завершает контейнер ровно один раз и ждёт его вместе с pipe лишь ограниченно.
   */
  private force(): void {
    if (this.forced) {
      return;
    }
    this.forced = true;
    clearTimeout(this.graceTimer);
    this.boundCleanup();
    this.cleanupEnded = false;
    this.cleanup = (this.tree ? this.tree.terminate() : Promise.resolve(this.killAnchor()))
      .catch(() => {
        this.outcome = { version: 1, kind: "failure", reason: "cleanup" };
        this.killAnchor();
      })
      .finally(() => {
        this.cleanupEnded = true;
      });
    this.child.stdin?.destroy();
    void Promise.all([this.closed.promise, this.cleanup, this.drained]).then(() =>
      this.finished.resolve(),
    );
  }

  /**
   * Не ждёт close бесконечно: по локальному timer закрывает собственные дескрипторы и IPC.
   */
  private boundCleanup(): void {
    this.cleanupTimer = setTimeout(() => {
      this.outcome = { version: 1, kind: "failure", reason: "cleanup" };
      this.killAnchor();
      this.child.stdin?.destroy();
      this.child.stdout?.destroy();
      this.child.stderr?.destroy();
      if (this.child.connected) {
        this.child.disconnect();
      }
      this.child.unref();
      this.finished.resolve();
    }, treeCleanupMs);
  }

  /**
   * Fallback адресует только ещё не завершившийся собственный ChildProcess, без taskkill/PID-повторов.
   */
  private killAnchor(): void {
    if (this.child.exitCode === null && this.child.signalCode === null) {
      this.child.kill("SIGKILL");
    }
  }

  /**
   * Закрывает native handle после cleanup; ошибка освобождения не становится успехом.
   */
  private disposeTree(): void {
    try {
      this.tree?.dispose();
    } catch {
      this.outcome = { version: 1, kind: "failure", reason: "cleanup" };
    }
  }
}

/**
 * Исполняет запрос в отдельном guardian, независимо от жизни исходного владельца.
 */
export function executeGuardedCommand(
  request: GuardianRequest,
  cancellation: AbortSignal,
): Promise<GuardianResponse> {
  try {
    return new GuardianExecution(request, cancellation).run();
  } catch (cause) {
    return Promise.reject(
      cause instanceof GuardedCommandError
        ? cause
        : new GuardedCommandError("spawn", spawnDiagnostic("anchor-spawn", cause)),
    );
  }
}
