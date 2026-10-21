import type { HistoryCheckpoint, HistorySession } from "./history/history.types";
import type { KnowledgeRecord } from "./knowledge/knowledge.types";
import type { PlanningRecord } from "./planning/planning.types";
import type { TaskRecord } from "./tasks/tasks.types";

/**
 * Проверенная Core предметная запись; kind определяет допустимую форму data.
 * В отличие от EntityRecord, содержимое и вложенные данные уже декодированы.
 */
export type ProjectEntity =
  KnowledgeRecord | TaskRecord | PlanningRecord | HistorySession | HistoryCheckpoint;
