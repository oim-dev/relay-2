import type { HistoryCheckpoint, HistorySession } from "./history";
import type { KnowledgeRecord } from "./knowledge";
import type { PlanningRecord } from "./planning";
import type { TaskRecord } from "./tasks";

/** Проверенная предметная запись; вид определяет допустимую форму data. */
export type ProjectEntity =
  KnowledgeRecord | TaskRecord | PlanningRecord | HistorySession | HistoryCheckpoint;
