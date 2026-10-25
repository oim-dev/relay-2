import type { HttpProjectEvent } from "@relay/contracts";
import { createRelayHttpMethods } from "./operations";
import type { RelayClient, RelayClientOptions } from "./client.types";

/**
 * Проверяет JSON object на транспортной границе, не объявляя его предметным DTO.
 */
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Создаёт совместимый Contracts facade над generated operations и общим HttpClient.
 * Успешный payload типизируется опубликованным контрактом сервера; оболочка проверяется runtime.
 * Клиент никогда не обновляет CAS, не создаёт автора и не повторяет запись автоматически.
 */
export function createRelayClient(options: RelayClientOptions = {}): RelayClient {
  const base = (options.baseUrl ?? "").replace(/\/$/, "");
  const methods = createRelayHttpMethods(options);

  /**
   * Возвращает SSE URL с экранированием постоянного ID проекта.
   */
  function eventsUrl(projectId: string): string {
    return `${base}/api/v2/projects/${encodeURIComponent(projectId)}/events`;
  }

  /**
   * Подписывается на инвалидирование кеша; reconnect connected также требует перечитать данные.
   * Возвращённая функция освобождает соединение EventSource.
   */
  function subscribe(
    projectId: string,
    listener: (event: HttpProjectEvent) => void,
    onError?: () => void,
  ): () => void {
    const source = new EventSource(eventsUrl(projectId));
    for (const type of ["connected", "changed", "storage-error", "heartbeat"] as const) {
      source.addEventListener(type, (event) => {
        try {
          const value: unknown = JSON.parse(event.data);
          if (!object(value) || value.projectId !== projectId || value.type !== type) {
            onError?.();
            return;
          }
          if (type !== "storage-error" && typeof value.generation === "number") {
            listener({ type, projectId, generation: value.generation });
          } else if (
            type === "storage-error" &&
            (value.generation === null || typeof value.generation === "number") &&
            object(value.error) &&
            typeof value.error.code === "string" &&
            typeof value.error.message === "string"
          ) {
            listener({
              type,
              projectId,
              generation: value.generation,
              error: { code: value.error.code, message: value.error.message },
            });
          } else {
            onError?.();
          }
        } catch {
          onError?.();
        }
      });
    }
    source.onerror = () => onError?.();
    return () => source.close();
  }

  return {
    ...methods,
    eventsUrl,
    subscribe,
  };
}
