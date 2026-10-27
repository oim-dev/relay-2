import type { GitSyncControlOutcome } from "@relay/contracts";
import type { RelayClient } from "@relay/rest-sdk";
import { relayClient, RelayApiError } from "infra/tasks-api";
import { projectSynchronization } from "./synchronization-mapper";
import { synchronizationMessages as m } from "./synchronization.messages";
import type { ProjectSynchronization, SynchronizationRequest } from "./synchronization.types";

export type { ProjectSynchronization } from "./synchronization.types";

/**
 * Ожидаемая недоступность обмена не блокирует локальные формы; cause сохраняется.
 */
export class ProjectSynchronizationError extends Error {}

/**
 * Владеет now/outcome одного транспорта. Параллельные действия разделяют один
 * запрос; queued/running/unknown наблюдаются только по исходному ID. Полная потеря
 * ответа без ID блокирует новый now, поскольку проверить прежний исход невозможно.
 */
export function createProjectSynchronization(client: Pick<RelayClient, "read" | "gitSyncNow">): {
  status(project: string): Promise<ProjectSynchronization>;
  request(project: string): Promise<ProjectSynchronization>;
} {
  const requests = new Map<string, SynchronizationRequest>();
  const running = new Map<string, Promise<ProjectSynchronization>>();

  /**
   * Запоминает реальный outcome и не объявляет unknown завершением.
   */
  const remember = (project: string, outcome: GitSyncControlOutcome): void => {
    if (
      typeof outcome?.requestId !== "string" ||
      outcome.requestId === "" ||
      !["queued", "running", "completed", "failed", "unknown"].includes(outcome.state)
    ) {
      throw new ProjectSynchronizationError(m.invalidOutcome);
    }
    let error: string | null = null;
    if (outcome.state === "failed") error = outcome.error.message;
    else if (outcome.state === "unknown") error = m.unknown;
    requests.set(project, {
      requestId: outcome.requestId,
      state: outcome.state,
      error,
    });
  };

  /**
   * Поздний ответ старого requestId не заменяет состояние нового явного запроса.
   */
  const observe = async (project: string, request: SynchronizationRequest): Promise<void> => {
    if (request.requestId === null) return;
    const { data } = await client.read(project, "gitSyncRequest", { requestId: request.requestId });
    if (data.requestId !== request.requestId)
      throw new ProjectSynchronizationError(m.wrongIdentity);
    if (requests.get(project) === request) remember(project, data);
  };

  /**
   * Обновляет cached доставку без повторного чтения только что полученного outcome.
   */
  const cached = async (project: string): Promise<ProjectSynchronization> => {
    const { data } = await client.read(project, "gitSyncStatus", {});
    return projectSynchronization(data, requests.get(project));
  };

  /**
   * Cached status не запускает now. При незавершённом запросе дополнительно
   * наблюдает его ID, чтобы queued/running не оставались навсегда устаревшими.
   */
  const status = async (project: string): Promise<ProjectSynchronization> => {
    try {
      const request = requests.get(project);
      if (request && request.state !== "completed" && request.state !== "failed")
        await observe(project, request);
      return await cached(project);
    } catch (error) {
      if (error instanceof ProjectSynchronizationError) throw error;
      throw new ProjectSynchronizationError(
        error instanceof Error ? error.message : m.unavailable,
        { cause: error },
      );
    }
  };

  /**
   * Начинает новый now только без незавершённого прежнего. Достоверный terminal
   * outcome допускает следующее явное действие, но не автоматический повтор.
   */
  const send = async (project: string): Promise<ProjectSynchronization> => {
    const previous = requests.get(project);
    if (previous && previous.state !== "completed" && previous.state !== "failed") {
      if (previous.requestId === null) throw new ProjectSynchronizationError(m.lostIdentity);
      return status(project);
    }
    requests.set(project, { requestId: null, state: "running", error: null });
    try {
      remember(project, (await client.gitSyncNow(project)).data);
    } catch (error) {
      const id = error instanceof RelayApiError ? error.details?.requestId : undefined;
      if (typeof id === "string" && id !== "")
        requests.set(project, { requestId: id, state: "unknown", error: m.unknown });
      else if (
        error instanceof RelayApiError &&
        error.status >= 400 &&
        error.status < 500 &&
        error.status !== 408 &&
        error.code !== "INVALID_RESPONSE"
      )
        requests.delete(project);
      else requests.set(project, { requestId: null, state: "unknown", error: m.lostIdentity });
      throw new ProjectSynchronizationError(
        requests.get(project)?.error ?? (error instanceof Error ? error.message : m.unavailable),
        { cause: error },
      );
    }
    return cached(project);
  };

  /**
   * Дедуплицирует одновременные нажатия и потребителей одного проекта.
   */
  const request = (project: string): Promise<ProjectSynchronization> => {
    const existing = running.get(project);
    if (existing) return existing;
    const operation = send(project).finally(() => running.delete(project));
    running.set(project, operation);
    return operation;
  };
  return { status, request };
}

const synchronization = createProjectSynchronization(relayClient);

/**
 * Читает статус выбранного проекта через общий клиент текущего origin.
 */
export const getProjectSynchronization = synchronization.status;

/**
 * Явно запускает либо наблюдает одну операцию, сохраняя её после смены проекта.
 */
export const requestProjectSynchronization = synchronization.request;
