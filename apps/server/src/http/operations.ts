import type { HttpOperationDefinition, HttpOperationName } from "./operations.types";

/**
 * Единственный каталог wire-маршрутов. Каждый endpoint реализован отдельным Nest handler.
 * Импорт не создаёт приложение, не читает окружение и не открывает пользовательские БД.
 */
export const HTTP_OPERATIONS = {
  context: { method: "GET", path: "/api/v2/context" },
  entity: { method: "GET", path: "/api/v2/projects/{projectId}/entity" },
  entities: { method: "GET", path: "/api/v2/projects/{projectId}/entities" },
  command: {
    method: "POST",
    path: "/api/v2/projects/{projectId}/commands",
    body: "commandRequest",
  },
  batch: { method: "POST", path: "/api/v2/projects/{projectId}/batch", body: "batchRequest" },
  receipt: { method: "GET", path: "/api/v2/projects/{projectId}/receipts" },
  overview: { method: "GET", path: "/api/v2/projects/{projectId}/overview" },
  projectStatus: { method: "GET", path: "/api/v2/projects/{projectId}/status" },
  projectCheck: { method: "GET", path: "/api/v2/projects/{projectId}/doctor" },
  documentSections: { method: "GET", path: "/api/v2/projects/{projectId}/documents/sections" },
  documentLinks: { method: "GET", path: "/api/v2/projects/{projectId}/documents/{ref}/links" },
  applicationParticipation: {
    method: "GET",
    path: "/api/v2/projects/{projectId}/applications/{ref}/participation",
  },
  taskProgress: { method: "GET", path: "/api/v2/projects/{projectId}/tasks/{ref}/progress" },
  taskViews: { method: "GET", path: "/api/v2/projects/{projectId}/task-views" },
  taskCandidates: { method: "GET", path: "/api/v2/projects/{projectId}/task-candidates" },
  taskComments: { method: "GET", path: "/api/v2/projects/{projectId}/tasks/{ref}/comments" },
  taskComment: { method: "GET", path: "/api/v2/projects/{projectId}/tasks/{ref}/comments/{id}" },
  taskCriteria: { method: "GET", path: "/api/v2/projects/{projectId}/tasks/{ref}/criteria" },
  taskCriterion: { method: "GET", path: "/api/v2/projects/{projectId}/tasks/{ref}/criteria/{id}" },
  taskDependencies: {
    method: "GET",
    path: "/api/v2/projects/{projectId}/tasks/{ref}/dependencies",
  },
  taskChildren: { method: "GET", path: "/api/v2/projects/{projectId}/tasks/{ref}/children" },
  taskRelated: { method: "GET", path: "/api/v2/projects/{projectId}/tasks/{ref}/related" },
  taskMemberships: { method: "GET", path: "/api/v2/projects/{projectId}/tasks/{ref}/memberships" },
  planProgress: { method: "GET", path: "/api/v2/projects/{projectId}/plans/{ref}/progress" },
  planStages: { method: "GET", path: "/api/v2/projects/{projectId}/plans/{ref}/stages" },
  planStage: { method: "GET", path: "/api/v2/projects/{projectId}/plans/{ref}/stages/{stageId}" },
  planStageTasks: {
    method: "GET",
    path: "/api/v2/projects/{projectId}/plans/{ref}/stages/{stageId}/tasks",
  },
  releaseProgress: { method: "GET", path: "/api/v2/projects/{projectId}/releases/{ref}/progress" },
  releasePlans: { method: "GET", path: "/api/v2/projects/{projectId}/releases/{ref}/plans" },
  historySessions: { method: "GET", path: "/api/v2/projects/{projectId}/history/sessions" },
  historyTimeline: { method: "GET", path: "/api/v2/projects/{projectId}/history/timeline" },
  relationNeighborhood: {
    method: "GET",
    path: "/api/v2/projects/{projectId}/relation-neighborhood",
  },
  historySession: { method: "GET", path: "/api/v2/projects/{projectId}/history/sessions/{ref}" },
  historyContext: {
    method: "GET",
    path: "/api/v2/projects/{projectId}/history/sessions/{ref}/context",
  },
  historyTree: { method: "GET", path: "/api/v2/projects/{projectId}/history/sessions/{ref}/tree" },
  historyIntents: {
    method: "GET",
    path: "/api/v2/projects/{projectId}/history/sessions/{ref}/intents",
  },
  historyCheckpoints: { method: "GET", path: "/api/v2/projects/{projectId}/history/checkpoints" },
  historyCheckpoint: {
    method: "GET",
    path: "/api/v2/projects/{projectId}/history/checkpoints/{ref}",
  },
  search: { method: "GET", path: "/api/v2/projects/{projectId}/search" },
  getMany: { method: "GET", path: "/api/v2/projects/{projectId}/get" },
  gitSyncStatus: { method: "GET", path: "/api/v2/projects/{projectId}/git-sync/status" },
  gitSyncNow: {
    method: "POST",
    path: "/api/v2/projects/{projectId}/git-sync/now",
    body: "gitSyncNowRequest",
  },
  gitSyncRequest: {
    method: "GET",
    path: "/api/v2/projects/{projectId}/git-sync/requests/{requestId}",
  },
  gitSyncConflicts: { method: "GET", path: "/api/v2/projects/{projectId}/git-sync/conflicts" },
  gitSyncConflict: { method: "GET", path: "/api/v2/projects/{projectId}/git-sync/conflicts/{id}" },
} as const satisfies Readonly<Record<HttpOperationName, HttpOperationDefinition>>;
