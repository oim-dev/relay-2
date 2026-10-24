import type { EntityRecord, ProjectEntity } from "@relay/contracts";
import { decodeHistoryCheckpoint, decodeHistorySession } from "../history/history-data";
import { decodeKnowledge } from "../knowledge/knowledge-data";
import { decodePlanning } from "../planning/planning-data";
import { taskRecord } from "../tasks/task-data";

/**
 * Проверяет сохранённый агрегат по его виду без I/O и изменения исходной записи.
 * Исторический sectionId документа сохраняется; эффективная проекция раздела принадлежит читателю.
 * Повреждённая оболочка или предметное содержание дают CORRUPT_DATA.
 */
export function decodeEntityRecord(
  record: Readonly<EntityRecord>,
  projectId: string,
): ProjectEntity {
  switch (record.kind) {
    case "task":
      return taskRecord(record);
    case "work-plan":
    case "release":
      return decodePlanning(record, projectId);
    case "work-session":
      return decodeHistorySession(record);
    case "work-checkpoint":
      return decodeHistoryCheckpoint(record);
    default:
      return decodeKnowledge(record, record.kind);
  }
}
