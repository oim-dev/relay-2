import type { RelayClient } from "@relay/rest-sdk";

/**
 * Проверенная публикация standalone Server; UUID нужен для штатной остановки через CLI.
 */
export interface WorkflowServerReady {
  /* Фактический IPv4 loopback origin без пути, query и credentials. */
  readonly url: string;
  /* UUID Runtime регистрации из полного JSON ready-сообщения. */
  readonly instanceId: string;
}

/**
 * Самостоятельный сервер сквозного маршрута, скопированный вне каталога поставки.
 */
export interface WorkflowServer {
  /* Фактический loopback URL, опубликованный после readiness. */
  readonly url: string;
  /* Настроенный SDK, вызывающий реальный HTTP поставляемого бинарника. */
  readonly client: RelayClient;

  /**
   * Выполняет настоящий Fetch с deadline и отменой при close, включая чтение тела ответа.
   */
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;

  /**
   * Останавливает свою регистрацию через CLI control, ждёт child и drain с deadline; повтор сохраняет исход.
   * Нештатный exit/cleanup даёт WorkflowServerCleanupError: файлы окружения следует сохранить.
   */
  close(): Promise<void>;
}
