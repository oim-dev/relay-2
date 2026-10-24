import type { Readable } from "node:stream";
import { GuardedCommandError } from "./errors";
import type { GuardedCommandFailureReason } from "./guardian.types";
import { maxOutputChunkBytes } from "./protocol";
import type { GuardianOutput, GuardianRequest } from "./protocol.types";

/**
 * Потеря IPC читателя означает конец владельца, а не повреждённый UTF-8 команды.
 * Это сохраняет EOF-first shutdown stdinLease даже при оборванном streaming write.
 */
function sendingFailure(cause: unknown): GuardedCommandError {
  const disconnected =
    !process.connected ||
    (cause instanceof Error &&
      "code" in cause &&
      ["EPIPE", "ERR_IPC_CHANNEL_CLOSED", "ERR_IPC_DISCONNECTED"].includes(String(cause.code)));
  return new GuardedCommandError(disconnected ? "cancelled" : "guardian", { cause });
}

/**
 * Два конкурентных raw-потока с отдельными/общим лимитами и ограниченным streaming IPC.
 * В каждом потоке одновременно ожидается не более одного отправленного chunk.
 */
export class CommandOutput {
  /* Проверенные правила накопления и потокового вывода. */
  private readonly request: GuardianRequest;
  /* Первая ошибка передаётся владельцу дерева, который ограниченно завершает процессы. */
  private readonly fail: (reason: GuardedCommandFailureReason) => void;
  /* Остановка освобождает pending IPC write независимо от callback умершего получателя. */
  private readonly cancellation: AbortSignal;
  /* Сохранённые байты stdout. */
  private readonly stdout: Buffer[] = [];
  /* Сохранённые байты stderr. */
  private readonly stderr: Buffer[] = [];
  /* Исходный объём каждого сохранённого потока. */
  private readonly sizes = { stdout: 0, stderr: 0 };

  /**
   * Создаёт отдельный буфер вывода одной команды без изменения переданных потоков.
   */
  constructor(
    request: GuardianRequest,
    cancellation: AbortSignal,
    fail: (reason: GuardedCommandFailureReason) => void,
  ) {
    this.request = request;
    this.cancellation = cancellation;
    this.fail = fail;
  }

  /**
   * Читает один pipe; строгий UTF-8 проверяет байты, не заменяя бинарный результат текстом.
   * После отмены дренирует без накопления до cleanup, чтобы backpressure/SIGPIPE не блокировали EOF lease.
   */
  async read(stream: Readable, name: "stdout" | "stderr"): Promise<void> {
    const streaming = name === "stdout" ? this.request.streamStdout : this.request.streamStderr;
    let forwarding = streaming;
    const validator =
      name === "stdout" && this.request.strictStdout
        ? new TextDecoder("utf-8", { fatal: true, ignoreBOM: true })
        : undefined;
    try {
      for await (const value of stream) {
        if (!(value instanceof Uint8Array)) {
          throw new GuardedCommandError("protocol");
        }
        const chunk = Buffer.from(value);
        if (!streaming) {
          this.append(name, chunk);
        }
        validator?.decode(chunk, { stream: true });
        if (forwarding) {
          forwarding = await this.forward(name, chunk);
        }
      }
      validator?.decode();
    } catch (error) {
      this.fail(error instanceof GuardedCommandError ? error.reason : "protocol");
    }
  }

  /**
   * Передаёт chunk ограниченными сообщениями; отмена или ошибка прекращают forwarding, но не drain.
   */
  private async forward(name: "stdout" | "stderr", chunk: Buffer): Promise<boolean> {
    try {
      for (let offset = 0; offset < chunk.length; offset += maxOutputChunkBytes) {
        const sent = await this.send({
          version: 1,
          kind: "output",
          stream: name,
          data: chunk.subarray(offset, offset + maxOutputChunkBytes).toString("base64"),
        });
        if (!sent) {
          return false;
        }
      }
      return true;
    } catch (error) {
      this.fail(error instanceof GuardedCommandError ? error.reason : "guardian");
      return false;
    }
  }

  /**
   * Возвращает принятые исходные байты; streaming-поток в ответе пуст.
   */
  bytes(name: "stdout" | "stderr"): Buffer {
    return Buffer.concat(name === "stdout" ? this.stdout : this.stderr);
  }

  /**
   * Сохраняет только доступный общий и отдельный бюджет, затем сообщает превышение.
   */
  private append(name: "stdout" | "stderr", chunk: Buffer): void {
    const available = Math.max(
      0,
      Math.min(
        this.request.maxOutputBytes - this.sizes.stdout - this.sizes.stderr,
        this.request.maxOutputBytesPerStream - this.sizes[name],
      ),
    );
    const accepted = Math.min(available, chunk.length);
    if (accepted > 0) {
      (name === "stdout" ? this.stdout : this.stderr).push(
        Buffer.from(chunk.subarray(0, accepted)),
      );
      this.sizes[name] += accepted;
    }
    if (accepted < chunk.length) {
      this.fail("output-limit");
    }
  }

  /**
   * Ждёт один ограниченный IPC-message либо отмену. false освобождает drain при pending callback:
   * синхронный stdout команды на Windows иначе не даст её event loop обработать stdin EOF.
   */
  private async send(message: GuardianOutput): Promise<boolean> {
    if (this.cancellation.aborted) {
      return false;
    }
    const send = process.send;
    if (!send) {
      throw new GuardedCommandError("protocol");
    }
    const pending = Promise.withResolvers<boolean>();
    /**
     * Поздний callback уже отменённой отправки не запускает новую очередь и не удерживает чтение pipe.
     */
    const cancel = (): void => pending.resolve(false);
    this.cancellation.addEventListener("abort", cancel, { once: true });
    try {
      send(message, (error: Error | null) =>
        error ? pending.reject(sendingFailure(error)) : pending.resolve(true),
      );
      return await pending.promise;
    } catch (cause) {
      throw cause instanceof GuardedCommandError ? cause : sendingFailure(cause);
    } finally {
      this.cancellation.removeEventListener("abort", cancel);
    }
  }
}
