import { createApiClient } from "../dist/generated/create-api-client";
import * as operations from "../dist/generated/operations";
import { createRelayTransport } from "./transport";
import { createRelayReaders } from "./readers";
import { pathParameter, requiredParameter, successfulResponse } from "./operation-boundary";
import type { RelayClientOptions } from "./client.types";
import type { RelayHttpMethods } from "./operations.types";

/**
 * Собирает точный Contracts facade над generated operations и одним HttpClient.
 * Guards, ключи операций и тела передаются дословно; автоматического retry нет.
 */
export function createRelayHttpMethods(options: RelayClientOptions): RelayHttpMethods {
  // Группы Swagger описывают документацию; стабильный facade связывается по operationId.
  const api = createApiClient(createRelayTransport(options), operations);
  const readers = createRelayReaders(api);

  return {
    context: () => successfulResponse(api.context()),
    entity: async (projectId, ref, query = {}) =>
      successfulResponse(
        api.entity({
          ...query,
          projectId: pathParameter("projectId", projectId),
          ref: requiredParameter("ref", ref),
        }),
      ),
    entities: async (projectId, query) =>
      successfulResponse(
        api.entities({
          ...query,
          projectId: pathParameter("projectId", projectId),
        }),
      ),
    command: async (projectId, body) =>
      successfulResponse(
        api.command(
          { projectId: pathParameter("projectId", projectId) },
          // Legacy Contracts допускает строковый op; сервер проверяет точный discriminated input.
          // Generated transport только сериализует тело и не изменяет readonly поля Contracts.
          body as Parameters<typeof api.command>[1],
        ),
      ),
    batch: async (projectId, body) =>
      successfulResponse(
        api.batch(
          { projectId: pathParameter("projectId", projectId) },
          // Тот же совместимый wire input; readonly commands не копируются и не изменяются.
          body as Parameters<typeof api.batch>[1],
        ),
      ),
    receipt: async (projectId, operationKey) =>
      successfulResponse(
        api.receipt({
          projectId: pathParameter("projectId", projectId),
          operationKey,
        }),
      ),
    overview: async (projectId) =>
      successfulResponse(api.overview({ projectId: pathParameter("projectId", projectId) })),
    read: async (projectId, operation, parameters) => readers[operation](projectId, parameters),
    gitSyncNow: async (projectId) =>
      successfulResponse(api.gitSyncNow({ projectId: pathParameter("projectId", projectId) }, {})),
  };
}
