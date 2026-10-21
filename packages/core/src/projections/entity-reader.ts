import type { EntityRecord, ProjectEntity } from "@relay/contracts";
import type { ProjectDatabase } from "@relay/storage";
import { EntityService } from "../entities/entities";
import {
  indexDocumentSections,
  validateDocumentSection,
  type DocumentSectionIndex,
} from "../knowledge/document-sections";
import { decodeHistoryCheckpoint, decodeHistorySession } from "../history/history-data";
import { decodeKnowledge } from "../knowledge/knowledge-data";
import { decodePlanning } from "../planning/planning-data";
import { taskRecord } from "../tasks/task-data";

/**
 * Проверенное чтение разных предметных видов в пределах одной операции.
 * Вызывающий сценарий удерживает snapshot/транзакцию и создаёт новый reader для каждого
 * вызова: индекс разделов принадлежит только этому снимку, а не времени жизни сервиса.
 */
export class EntityReader {
  /* Соединение проекта, снимок которого удерживается вызывающим сценарием. */
  private readonly db: ProjectDatabase;
  /* Общий resolver адресов и чтение сырых карточек из того же соединения. */
  private readonly entities: EntityService;
  /* Индекс разделов текущего снимка; до первого документа не загружается. */
  private sections?: DocumentSectionIndex;

  /**
   * Создаёт reader на время одной операции; соединение остаётся во владении вызывающего кода.
   */
  constructor(db: ProjectDatabase) {
    this.db = db;
    this.entities = new EntityService(db);
  }

  /**
   * Разрешает пользовательскую ссылку и проверяет предметную карточку в снимке операции.
   * Отсутствие цели даёт NOT_FOUND, повреждённое содержание — CORRUPT_DATA.
   */
  get(ref: string): ProjectEntity {
    return this.decode(this.entities.get(ref));
  }

  /**
   * Декодирует сохранённую запись по виду, не исправляя её и не выполняя запись в БД.
   * Все документы reader используют единственный лениво загруженный индекс разделов проекта.
   * Неизвестный раздел отклоняется, ссылка на легально удалённый раздел остаётся допустимой.
   */
  decode(record: Readonly<EntityRecord>): ProjectEntity {
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
