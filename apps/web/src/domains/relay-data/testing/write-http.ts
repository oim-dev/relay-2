/// <reference types="bun" />
import { createRelayClient, type RelayClient } from "@relay/rest-sdk";

/**
 * Подменяет только Fetch: сериализация, URL и ошибки остаются настоящими из REST SDK.
 * Каждый тест владеет своим callback и writer; глобальный fetch не изменяется.
 */
export function createWriteHttpClient(
  handler: (request: Request) => Response | Promise<Response>,
): RelayClient {
  return createRelayClient({
    baseUrl: "https://relay.test",
    fetch: Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> =>
        handler(new Request(input, init)),
      { preconnect: fetch.preconnect },
    ),
  });
}
