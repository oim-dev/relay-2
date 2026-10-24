import { runCommandAnchor } from "./anchor";
import { GuardedCommandError } from "./errors";
import { executeGuardedCommand } from "./execution";
import { readLease, writeFrame } from "./frame";
import { decodeControl, decodeRequest, maxRequestBytes } from "./protocol";
import type { GuardianResponse } from "./protocol.types";

/**
 * Приватная роль --guarded-command того же бинарника; вызывается до обычного CLI-парсера.
 * Владеет stdin/stdout процесса. Возвращаемый код относится к протоколу, не к исходной команде.
 * Вызывающий завершает процесс этим кодом и не пишет в stdout роли другую информацию.
 */
export async function runGuardianEntry(): Promise<number> {
  const lease = readLease(process.stdin);
  const cancellation = new AbortController();
  /**
   * SIGTERM/SIGINT самого guardian превращается в тот же независимый путь очистки.
   */
  const terminate = (): void => cancellation.abort("SIGTERM");
  /**
   * Сохраняет SIGINT отдельно от закрытия stdin владельцем.
   */
  const interrupt = (): void => cancellation.abort("SIGINT");
  /**
   * Разрыв канала владельца закрывает lease target прежде, чем streaming EPIPE станет другой ошибкой.
   */
  const disconnected = (): void => cancellation.abort("cancelled");
  /**
   * Служебный IPC передаёт только причину остановки, без режима передачи потомков.
   */
  const onControl = (value: unknown): void => {
    try {
      const command = decodeControl(value);
      cancellation.abort(command.stdinOnly ? "stdin-eof" : command.signal);
    } catch {
      cancellation.abort("protocol");
    }
  };
  process.on("SIGTERM", terminate);
  process.on("SIGINT", interrupt);
  process.on("message", onControl);
  let response: GuardianResponse;
  try {
    const request = decodeRequest(await lease.request);
    if (request.role === "anchor") {
      if (typeof process.send !== "function") {
        throw new GuardedCommandError("protocol");
      }
      return await runCommandAnchor(request, lease.signal, cancellation.signal);
    }
    if ((request.streamStdout || request.streamStderr) && typeof process.send !== "function") {
      throw new GuardedCommandError("protocol");
    }
    process.on("disconnect", disconnected);
    process.send?.({ version: 1, kind: "ready" }, () => {});
    response = await executeGuardedCommand(
      request,
      AbortSignal.any([lease.signal, cancellation.signal]),
    );
  } catch (error) {
    response = {
      version: 1,
      kind: "failure",
      reason: error instanceof GuardedCommandError ? error.reason : "guardian",
      ...(error instanceof GuardedCommandError && error.stage !== undefined
        ? { stage: error.stage }
        : {}),
      ...(error instanceof GuardedCommandError && error.systemCode !== undefined
        ? { systemCode: error.systemCode }
        : {}),
      stdout: "",
      stderr: "",
    };
  } finally {
    lease.dispose();
    process.off("SIGTERM", terminate);
    process.off("SIGINT", interrupt);
    process.off("message", onControl);
    process.off("disconnect", disconnected);
    if (process.connected) {
      process.disconnect?.();
    }
  }
  // Эта точка недостижима в роли anchor: создание Writable там удерживало бы дубликат output pipe.
  process.stdout.on("error", () => {
    // Погибший владелец больше не читает ответ; очистка дерева уже выполнена до записи.
  });
  try {
    await writeFrame(process.stdout, response, maxRequestBytes);
    return 0;
  } catch {
    return 1;
  }
}
