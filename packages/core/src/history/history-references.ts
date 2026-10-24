import {
  RelayError,
  type EntityRecord,
  type HistoryReference,
  type ProjectEntity,
} from "@relay/contracts";
import { entityMessages } from "../entities/entity.messages";
import { decodeKnowledge } from "../knowledge/knowledge-data";
import { indexDocumentSections, projectDocumentSection } from "../knowledge/document-sections";
import { decodePlanning } from "../planning/planning-data";
import { taskRecord } from "../tasks/task-data";
import { decodeHistoryCheckpoint, decodeHistorySession } from "./history-data";

/**
 * Выбирает предметное название проверенной цели; пустой продукт использует ключ.
 */
export function historyReferenceTitle(target: Readonly<ProjectEntity>): string {
  switch (target.kind) {
    case "product":
      return target.data.name ?? target.key;
    case "project":
    case "feature":
    case "scenario":
    case "application":
    case "board":
    case "document":
      return target.data.name;
    default:
      return target.data.title;
  }
}

/**
 * Чисто декодирует выбранные цели и фиксирует их ключи/названия именно в момент шага.
 * Проект обязателен только для документов; снятые разделы проверяет общий codec проекции.
 */
export function snapshotHistoryReferences(
  records: readonly EntityRecord[],
  projectId: string,
  project: EntityRecord | null,
): HistoryReference[] {
  const sections =
    project === null ? null : indexDocumentSections(decodeKnowledge(project, "project"));
  return records.map((record) => {
    let target: ProjectEntity;
    switch (record.kind) {
      case "task":
        target = taskRecord(record);
        break;
      case "work-plan":
      case "release":
        target = decodePlanning(record, projectId);
        break;
      case "work-session":
        target = decodeHistorySession(record);
        break;
      case "work-checkpoint":
        target = decodeHistoryCheckpoint(record);
        break;
      case "document": {
        if (sections === null) {
          throw new RelayError("CORRUPT_DATA", entityMessages.missingResolvedRecord, 1, {
            id: projectId,
          });
        }
        target = projectDocumentSection(decodeKnowledge(record, "document"), sections);
        break;
      }
      default:
        target = decodeKnowledge(record, record.kind);
    }
    return {
      id: target.id,
      kind: target.kind,
      key: target.key,
      title: historyReferenceTitle(target),
    };
  });
}
