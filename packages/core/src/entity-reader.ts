import type { EntityRecord, ProjectEntity } from "@relay/contracts";
import type { ProjectDatabase } from "@relay/storage";
import { EntityService } from "./entities";
import {
  indexDocumentSections,
  validateDocumentSection,
  type DocumentSectionIndex,
} from "./document-sections";
import { decodeHistoryCheckpoint, decodeHistorySession } from "./history-data";
import { decodeKnowledge } from "./knowledge-data";
import { decodePlanning } from "./planning-data";
import { taskRecord } from "./task-data";

/**
 * Проверенное чтение разных предметных видов в пределах одной операции.
 * Вызывающий сценарий удерживает snapshot/транзакцию и создаёт новый reader для каждого
 * вызова: индекс разделов принадлежит только этому снимку, а не времени жизни сервиса.
 */
export class EntityReader {
  private readonly entities: EntityService;
  private sections?: DocumentSectionIndex;

  constructor(private readonly db: ProjectDatabase) {
    this.entities = new EntityService(db);
  }

  get(ref: string): ProjectEntity {
    return this.decode(this.entities.get(ref));
  }

  decode(record: EntityRecord): ProjectEntity {
    switch (record.kind) {
      case "task":
        return taskRecord(record);
      case "work-plan":
      case "release":
        return decodePlanning(record, this.db.projectId);
      case "work-session":
        return decodeHistorySession(record);
      case "work-checkpoint":
        return decodeHistoryCheckpoint(record);
      case "document": {
        const document = decodeKnowledge(record, "document");
        this.sections ??= indexDocumentSections(
          decodeKnowledge(this.entities.get(this.db.projectId, "project"), "project"),
        );
        validateDocumentSection(document, this.sections);
        return document;
      }
      default:
        return decodeKnowledge(record, record.kind);
    }
  }
}
