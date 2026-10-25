import type { HttpReadParameters, HttpReadResults } from "@relay/contracts";
import type { BoundApi } from "../dist/generated/create-api-client";
import type { HttpClient } from "../dist/generated/http-client";
import type * as operations from "../dist/generated/operations";
import type { RelayClient, RelayResponse } from "./client.types";

/**
 * Точные сигнатуры операций, связанные с единственным generated HttpClient.
 */
export type RelayGeneratedApi = BoundApi<typeof operations, HttpClient>;

/**
 * JSON-методы публичного facade; SSE принадлежит EventSource с отдельным временем жизни.
 */
export type RelayHttpMethods = Omit<RelayClient, "eventsUrl" | "subscribe">;

/**
 * Связь имени reader с его Contracts-параметрами и результатом без стирания discriminators.
 */
export type RelayReaders = {
  readonly [K in keyof HttpReadResults]: (
    projectId: string,
    parameters: HttpReadParameters[K],
  ) => Promise<RelayResponse<HttpReadResults[K]>>;
};
