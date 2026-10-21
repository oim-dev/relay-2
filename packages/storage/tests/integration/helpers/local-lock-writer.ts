import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { LockProcessMode, PendingProcessLine } from "./local-lock-process.types";

/**
 * Владеет процессом проверки mutex и построчным протоколом барьеров.
 * Потоки читаются сразу, процесс имеет дедлайн; тест обязан вызвать stop в очистке.
 */
export class LocalLockWriter {
  /* Дочерний Bun-процесс без собственных потомков. */
  readonly process: ChildProcessWithoutNullStreams;
  /* Завершение после закрытия stdout/stderr; null означает завершение сигналом. */
  readonly exited: Promise<number | null>;
  /* Полные строки, полученные до запроса next, в порядке вывода. */
  private readonly lines: string[] = [];
  /* Ожидающие читатели строк, обслуживаемые FIFO. */
  private readonly waiting: PendingProcessLine[] = [];
  /* Незавершённая строка stdout между событиями data. */
  private output = "";
  /* Накопленный stderr для диагностики преждевременного завершения. */
  private errors = "";
  /* Признак закрытия процесса и обоих читаемых потоков. */
  private closed = false;

  /**
   * Запускает изолированного участника с принудительным SIGKILL через четыре секунды.
   * Путь передаётся явно; до сигнала в stdin процесс не пытается получить mutex.
   */
  constructor(path: string, mode: LockProcessMode, actor: string) {
    this.process = spawn(
      process.execPath,
      [fileURLToPath(new URL("../local-lock-process.ts", import.meta.url)), path, mode, actor],
      { stdio: ["pipe", "pipe", "pipe"], timeout: 4000, killSignal: "SIGKILL" },
    );
    this.process.stderr.on("data", (chunk: Buffer) => {
      this.errors += chunk.toString();
    });
    this.process.stdout.on("data", (chunk: Buffer) => this.receiveOutput(chunk));
    this.exited = new Promise<number | null>((resolveExit) => {
      this.process.on("error", (error) => this.rejectWaiters(error));
      this.process.on("close", (code) => {
        this.closed = true;
        this.rejectWaiters(new Error(`Процесс закрыт (${code}): ${this.errors}`));
        resolveExit(code);
      });
    });
  }

  /**
   * Разрешает прохождение одного барьера, сохраняя stdin для следующего сигнала владельцу mutex.
   */
  signal(): void {
    this.process.stdin.write("!");
  }

  /**
   * Закрывает stdin после последнего переданного сигнала, не добавляя новый барьер.
   */
  closeInput(): void {
    this.process.stdin.end();
  }

  /**
   * Читает следующую строку протокола; преждевременный выход процесса отклоняет ожидание.
   */
  next(): Promise<string> {
    const line = this.lines.shift();
    if (line !== undefined) {
      return Promise.resolve(line);
    }
    if (this.closed) {
      return Promise.reject(new Error(`Процесс уже закрыт: ${this.errors}`));
    }
    return new Promise<string>((resolveLine, reject) => {
      this.waiting.push({ resolve: resolveLine, reject });
    });
  }

  /**
   * Гарантированно завершает живого участника и ожидает закрытия потоков, включая ошибку теста.
   */
  async stop(): Promise<void> {
    this.process.stdin.destroy();
    if (this.process.exitCode === null) {
      this.process.kill("SIGKILL");
    }
    await this.exited;
  }

  /**
   * Собирает строки из произвольных фрагментов stdout и передаёт их ожидающим читателям FIFO.
   */
  private receiveOutput(chunk: Buffer): void {
    this.output += chunk.toString();
    let newline: number;
    while ((newline = this.output.indexOf("\n")) !== -1) {
      const line = this.output.slice(0, newline);
      this.output = this.output.slice(newline + 1);
      const waiter = this.waiting.shift();
      if (waiter) {
        waiter.resolve(line);
      } else {
        this.lines.push(line);
      }
    }
  }

  /**
   * Завершает все текущие ожидания одной причиной отказа процесса.
   */
  private rejectWaiters(error: Error): void {
    for (const waiter of this.waiting.splice(0)) {
      waiter.reject(error);
    }
  }
}
