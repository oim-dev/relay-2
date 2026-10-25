import { ApiError, HttpClient } from "../dist/generated/http-client";
import { RelayApiError } from "./errors";
import { clientMessages } from "./client.messages";
import type { RelayClientOptions } from "./client.types";

/**
 * Проверяет объект транспортной оболочки, не объявляя неизвестные данные предметным DTO.
 */
function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Читает и проверяет HTTP envelope с сохранением status и исходной причины неверного JSON.
 * Предметные DTO принадлежат Contracts; их декодеры SDK не воспроизводит.
 */
async function parseRelayResponse(response: Response): Promise<unknown> {
  let value: unknown;
  try {
    value = await response.json();
  } catch (cause) {
    throw new RelayApiError(
      { code: "INVALID_RESPONSE", message: clientMessages.invalidResponse },
      response.status,
      cause,
    );
  }
  if (
    isObject(value) &&
    value.ok === false &&
    isObject(value.error) &&
    typeof value.error.code === "string" &&
    typeof value.error.message === "string"
  ) {
    throw new RelayApiError(
      {
        code: value.error.code,
        message: value.error.message,
        ...(isObject(value.error.details) ? { details: value.error.details } : {}),
      },
      response.status,
    );
  }
  if (!response.ok || !isObject(value) || value.ok !== true || !("data" in value)) {
    throw new RelayApiError(
      { code: "INVALID_RESPONSE", message: clientMessages.invalidResponse },
      response.status,
    );
  }
  return value;
}

/**
 * Сохраняет RelayApiError, которую generated HttpClient вложил в ApiError для non-2xx.
 * Сетевой отказ и отмена проходят без подмены и без повторного исполнения запроса.
 */
function rethrowRelayError(error: unknown): never {
  if (error instanceof ApiError && error.error instanceof RelayApiError) {
    throw error.error;
  }
  throw error;
}

/**
 * Настраивает единственный generated HttpClient для JSON-операций Relay.
 * Base URL и Fetch принадлежат вызывающему; экземпляр не содержит глобального состояния.
 */
export function createRelayTransport(options: RelayClientOptions = {}): HttpClient {
  return new HttpClient({
    baseUrl: (options.baseUrl ?? "").replace(/\/$/, ""),
    ...(options.fetch === undefined ? {} : { customFetch: options.fetch }),
    headers: { Accept: "application/json" },
    responseParser: parseRelayResponse,
    onError: rethrowRelayError,
  });
}
