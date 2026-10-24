import type { Readable, Writable } from "node:stream";
import { GuardedCommandError } from "./errors";
import type { GuardianLease } from "./protocol.types";
import { guardianGraceMs, maxRequestBytes } from "./protocol";

/**
 * Декодер ровно одного JSON-frame: uint32be длина, затем строго UTF-8 JSON.
 * Накопление линейно по размеру; лишние и усечённые байты считаются повреждением.
 */
export class FrameDecoder {
  /* Собранный четырёхбайтовый заголовок. */
  private readonly header = Buffer.alloc(4);
  /* Число уже полученных байтов заголовка. */
  private headerSize = 0;
  /* Тело выделяется только после проверки ограниченной длины. */
  private body: Buffer | undefined;
  /* Число уже полученных байтов тела. */
  private bodySize = 0;
  /* Предельный размер JSON-тела для конкретного направления. */
  private readonly limit: number;

  /**
   * Устанавливает предел до чтения любых недоверенных данных.
   */
  constructor(limit: number) {
    this.limit = limit;
  }

  /**
   * Принимает очередной chunk; отклоняет второй frame и данные после первого.
   */
  push(chunk: Buffer): void {
    let offset = 0;
    if (this.headerSize < 4) {
      const size = Math.min(4 - this.headerSize, chunk.length);
      chunk.copy(this.header, this.headerSize, 0, size);
      this.headerSize += size;
      offset = size;
      if (this.headerSize === 4) {
        const length = this.header.readUInt32BE();
        if (length === 0 || length > this.limit) {
          throw new GuardedCommandError("protocol");
        }
        this.body = Buffer.allocUnsafe(length);
      }
    }
    if (this.body) {
      const remaining = chunk.length - offset;
      if (remaining > this.body.length - this.bodySize) {
        throw new GuardedCommandError("protocol");
      }
      chunk.copy(this.body, this.bodySize, offset);
      this.bodySize += remaining;
    }
  }

  /**
   * Позволяет получить запрос, не закрывая lease после его frame.
   */
  complete(): boolean {
    return this.body !== undefined && this.bodySize === this.body.length;
  }

  /**
   * Декодирует только целое тело; ошибки UTF-8 и JSON сохраняются как cause.
   */
  value(): unknown {
    if (!this.body || !this.complete()) {
      throw new GuardedCommandError("protocol");
    }
    try {
      return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(this.body));
    } catch (cause) {
      throw new GuardedCommandError("protocol", { cause });
    }
  }
}

/**
 * Сериализует JSON с длиной в байтах; проверяет размер до публикации в pipe.
 */
export function encodeFrame(value: unknown, limit = maxRequestBytes): Buffer {
  const body = Buffer.from(JSON.stringify(value), "utf8");
  if (body.length === 0 || body.length > limit) {
    throw new GuardedCommandError("protocol");
  }
  const header = Buffer.alloc(4);
  header.writeUInt32BE(body.length);
  return Buffer.concat([header, body]);
}

/**
 * Пишет один frame с подтверждением flush, не закрывая управляющий stdin.
 */
export function writeFrame(
  stream: Writable,
  value: unknown,
  limit = maxRequestBytes,
): Promise<void> {
  const frame = encodeFrame(value, limit);
  return new Promise((resolve, reject) => {
    stream.write(frame, (error) => (error ? reject(error) : resolve()));
  });
}

/**
 * Читает запрос, продолжая наблюдать stdin до EOF даже после полного JSON-frame.
 * Deadline handshake не позволяет оставить пустой служебный процесс навсегда.
 */
export function readLease(stream: Readable): GuardianLease {
  const decoder = new FrameDecoder(maxRequestBytes);
  const cancellation = new AbortController();
  const pending = Promise.withResolvers<unknown>();
  let received = false;
  const timer = setTimeout(() => fail("protocol"), guardianGraceMs);

  /**
   * Сообщает единственную причину окончания lease и отклоняет незавершённый запрос.
   */
  function fail(reason: "protocol" | "cancelled"): void {
    clearTimeout(timer);
    cancellation.abort(reason);
    pending.reject(new GuardedCommandError(reason));
  }

  /**
   * Принимает frame; дальнейшие байты остаются запрещены до конца жизни lease.
   */
  function onData(chunk: Buffer): void {
    try {
      decoder.push(chunk);
      if (!received && decoder.complete()) {
        received = true;
        clearTimeout(timer);
        pending.resolve(decoder.value());
      }
    } catch {
      fail("protocol");
    }
  }

  /**
   * EOF — потеря владельца, включая SIGKILL без исполнения его finally.
   */
  function onEnd(): void {
    fail("cancelled");
  }

  /**
   * Ошибка чтения не превращается в успешный результат команды.
   */
  function onError(): void {
    fail("protocol");
  }

  stream.on("data", onData);
  stream.once("end", onEnd);
  stream.once("error", onError);
  return {
    request: pending.promise,
    signal: cancellation.signal,
    /**
     * Освобождает lease только после завершения всей служебной роли.
     */
    dispose(): void {
      clearTimeout(timer);
      stream.off("data", onData);
      stream.off("end", onEnd);
      stream.off("error", onError);
      stream.destroy();
    },
  };
}
