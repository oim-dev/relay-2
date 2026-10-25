import { Injectable } from "@nestjs/common";
import { RelayError } from "@relay/contracts";
import type { IncomingMessage, ServerResponse } from "node:http";
import { httpMessages } from "./http.messages";

/**
 * Учитывает принятые HTTP handlers, включая pipes и async writers до получения результата.
 * Разрыв клиента не отменяет начатый commit; shutdown ожидает исход операции.
 */
@Injectable()
export class RequestLifetime {
  /* Начатые handlers, независимо от текущего состояния сетевого соединения. */
  private readonly pending = new Set<Promise<unknown>>();
  /* Входные потоки до end/close, включая запросы, отвергнутые guard до interceptor. */
  private readonly inputs = new Set<IncomingMessage>();
  /* Синхронный барьер против новых операций после запроса shutdown. */
  private stopping = false;

  /**
   * Учитывает транспорт до guards/pipes. Отправленный 403 не означает завершённый request body.
   * End/close снимают listeners; после stop новый отказ закрывает соединение после flush ответа.
   */
  trackInput(request: IncomingMessage, response: ServerResponse): void {
    this.inputs.add(request);
    /**
     * Освобождает учёт после чтения всех байтов либо уничтожения входного потока.
     */
    const release = (): void => {
      this.inputs.delete(request);
      request.off("end", release);
      request.off("close", release);
    };
    request.once("end", release);
    request.once("close", release);
    if (request.destroyed) {
      release();
    }
    if (this.stopping) {
      response.setHeader("Connection", "close");
      // Guard вернёт SERVER_CLOSING; недочитанный новый POST не должен удерживать listener.
      response.once("finish", () => request.destroy());
    }
  }

  /**
   * Отвергает новый сценарий после начала shutdown.
   */
  assertOpen(): void {
    if (this.stopping) {
      throw new RelayError("SERVER_CLOSING", httpMessages.closing);
    }
  }

  /**
   * Удерживает Promise до его исхода и удаляет его из drain-набора при любом результате.
   */
  async run<T>(action: () => Promise<T>): Promise<T> {
    this.assertOpen();
    const operation = action();
    this.pending.add(operation);
    try {
      return await operation;
    } finally {
      this.pending.delete(operation);
    }
  }

  /**
   * Запрещает новые сценарии и прерывает только недочитанный транспортный ввод.
   * Core writer стартует после JsonBodyPipe; полный request и его async commit не отменяются.
   * Даже если клиент уже отключился, Promise принятого handler остаётся в pending до исхода.
   */
  stop(): void {
    this.stopping = true;
    for (const request of this.inputs) {
      if (!request.complete) {
        request.destroy();
      }
    }
  }

  /**
   * Ожидает все handlers, допущенные до stop.
   */
  async drain(): Promise<void> {
    await Promise.allSettled([...this.pending]);
  }
}
