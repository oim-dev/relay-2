import { createRelayClient } from "@relay/rest-sdk";

export { RelayApiError } from "@relay/rest-sdk";

/**
 * Один origin поставляемого Web; Vite проксирует тот же относительный API.
 */
export const serverKey = window.location.origin;
export const relayClient = createRelayClient({ baseUrl: serverKey });
