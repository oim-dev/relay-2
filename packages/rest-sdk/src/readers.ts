import type { EntityKind } from "@relay/contracts";
import { pathParameter, successfulResponse } from "./operation-boundary";
import type { RelayGeneratedApi, RelayReaders } from "./operations.types";

/**
 * Адаптирует стабильные параметры именованных readers к точным generated операциям.
 * Компилятор проверяет полноту каталога и совместимость каждого результата с Contracts.
 */
export function createRelayReaders(api: RelayGeneratedApi): RelayReaders {
  return {
    projectStatus: (projectId) => successfulResponse(api.projectStatus(project(projectId))),
    projectCheck: (projectId) => successfulResponse(api.projectCheck(project(projectId))),
    documentSections: (projectId) => successfulResponse(api.documentSections(project(projectId))),
    documentLinks: (projectId, parameters) =>
      successfulResponse(api.documentLinks(reference(projectId, parameters.ref, "document"))),
    applicationParticipation: (projectId, parameters) =>
      successfulResponse(
        api.applicationParticipation(reference(projectId, parameters.ref, "application")),
      ),
    taskProgress: (projectId, parameters) =>
      successfulResponse(api.taskProgress(reference(projectId, parameters.ref, "task"))),
    taskViews: (projectId, parameters) => {
      const { refs, ...query } = parameters.query;
      return successfulResponse(
        api.taskViews({
          ...query,
          ...(refs === undefined ? {} : { refs: [...refs] }),
          ...project(projectId),
        }),
      );
    },
    taskCandidates: (projectId, parameters) => {
      const { refs, ...query } = parameters.query;
      return successfulResponse(
        api.taskCandidates({
          ...query,
          ...(refs === undefined ? {} : { refs: [...refs] }),
          ...project(projectId),
        }),
      );
    },
    taskComments: (projectId, parameters) =>
      successfulResponse(api.taskComments(reference(projectId, parameters.ref, "task"))),
    taskComment: (projectId, parameters) =>
      successfulResponse(
        api.taskComment({
          ...reference(projectId, parameters.ref, "task"),
          id: pathParameter("id", parameters.id),
        }),
      ),
    taskCriteria: (projectId, parameters) =>
      successfulResponse(api.taskCriteria(reference(projectId, parameters.ref, "task"))),
    taskCriterion: (projectId, parameters) =>
      successfulResponse(
        api.taskCriterion({
          ...reference(projectId, parameters.ref, "task"),
          id: pathParameter("id", parameters.id),
        }),
      ),
    taskDependencies: (projectId, parameters) =>
      successfulResponse(api.taskDependencies(reference(projectId, parameters.ref, "task"))),
    taskChildren: (projectId, parameters) =>
      successfulResponse(api.taskChildren(reference(projectId, parameters.ref, "task"))),
    taskRelated: (projectId, parameters) =>
      successfulResponse(api.taskRelated(reference(projectId, parameters.ref, "task"))),
    taskMemberships: (projectId, parameters) =>
      successfulResponse(api.taskMemberships(reference(projectId, parameters.ref, "task"))),
    planProgress: (projectId, parameters) =>
      successfulResponse(api.planProgress(reference(projectId, parameters.ref, "work-plan"))),
    planStages: (projectId, parameters) =>
      successfulResponse(api.planStages(reference(projectId, parameters.ref, "work-plan"))),
    planStage: (projectId, parameters) =>
      successfulResponse(
        api.planStage({
          ...reference(projectId, parameters.ref, "work-plan"),
          stageId: pathParameter("stageId", parameters.stageId),
        }),
      ),
    planStageTasks: (projectId, parameters) =>
      successfulResponse(
        api.planStageTasks({
          ...reference(projectId, parameters.ref, "work-plan"),
          stageId: pathParameter("stageId", parameters.stageId),
        }),
      ),
    releaseProgress: (projectId, parameters) =>
      successfulResponse(api.releaseProgress(reference(projectId, parameters.ref, "release"))),
    releasePlans: (projectId, parameters) =>
      successfulResponse(api.releasePlans(reference(projectId, parameters.ref, "release"))),
    historySessions: (projectId, parameters) =>
      successfulResponse(api.historySessions({ ...parameters.query, ...project(projectId) })),
    historyTimeline: (projectId, parameters) =>
      successfulResponse(api.historyTimeline({ ...parameters.query, ...project(projectId) })),
    relationNeighborhood: (projectId, parameters) =>
      successfulResponse(api.relationNeighborhood({ ...parameters.query, ...project(projectId) })),
    historySession: (projectId, parameters) =>
      successfulResponse(api.historySession(reference(projectId, parameters.ref, "work-session"))),
    historyContext: (projectId, parameters) =>
      successfulResponse(api.historyContext(reference(projectId, parameters.ref, "work-session"))),
    historyTree: (projectId, parameters) =>
      successfulResponse(api.historyTree(reference(projectId, parameters.ref, "work-session"))),
    historyIntents: (projectId, parameters) =>
      successfulResponse(
        api.historyIntents({
          ...parameters.query,
          ...reference(projectId, parameters.ref, "work-session"),
        }),
      ),
    historyCheckpoints: (projectId, parameters) =>
      successfulResponse(api.historyCheckpoints({ ...parameters.query, ...project(projectId) })),
    historyCheckpoint: (projectId, parameters) =>
      successfulResponse(
        api.historyCheckpoint(reference(projectId, parameters.ref, "work-checkpoint")),
      ),
    search: (projectId, parameters) =>
      successfulResponse(api.search({ ...parameters.query, ...project(projectId) })),
    getMany: (projectId, parameters) =>
      successfulResponse(
        api.getMany({
          ...parameters.query,
          ...project(projectId),
          ref: [...parameters.query.ref],
        }),
      ),
    gitSyncStatus: (projectId) => successfulResponse(api.gitSyncStatus(project(projectId))),
    gitSyncRequest: (projectId, parameters) =>
      successfulResponse(
        api.gitSyncRequest({
          ...project(projectId),
          requestId: pathParameter("requestId", parameters.requestId),
        }),
      ),
    gitSyncConflicts: (projectId) => successfulResponse(api.gitSyncConflicts(project(projectId))),
    gitSyncConflict: (projectId, parameters) =>
      successfulResponse(
        api.gitSyncConflict({
          ...project(projectId),
          id: pathParameter("id", parameters.id),
        }),
      ),
  };
}

/**
 * Формирует encoded scope проекта для generated path interpolation.
 */
function project(projectId: string): { readonly projectId: string } {
  return { projectId: pathParameter("projectId", projectId) };
}

/**
 * Защищает только bare dot-адреса от URL-нормализации существующей typed reference Core.
 * Вид известен из reader; остальные ссылки, включая уже типизированные, не изменяются.
 * Разрешение адреса не выполняется: один reader остаётся одним HTTP-запросом.
 */
function reference(
  projectId: string,
  ref: string,
  kind: EntityKind,
): { readonly projectId: string; readonly ref: string } {
  const address = ref === "." || ref === ".." ? `${kind}:${ref}` : ref;
  return { ...project(projectId), ref: pathParameter("ref", address) };
}
