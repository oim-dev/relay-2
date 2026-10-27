import { createRelayClient } from "@relay/rest-sdk";

/**
 * Единственный браузерный транспорт к текущему REST API Relay.
 */
export const relayClient = createRelayClient();
