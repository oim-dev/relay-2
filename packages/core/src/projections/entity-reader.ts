import {
  RelayError,
  type EntityRecord,
  type KnowledgeRecord,
  type ProjectEntity,
} from "@relay/contracts";
import type { ProjectDatabase } from "@relay/storage";
import { EntityService } from "../entities/entities";
import { entityMessages } from "../entities/entity.messages";
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
  /* Проект из снимка; null означает известное отсутствие, undefined — необходимость чтения. */
  private readonly projectRecord: Readonly<EntityRecord> | null | undefined;
  /* Проверенный проект только текущей операции, общий для карточки и индекса разделов. */
  private decodedProject?: KnowledgeRecord<"project">;
  /* Индекс разделов текущего снимка; до первого документа не строится. */
  private sections?: DocumentSectionIndex;

  /**
   * Создаёт reader на время одной операции; соединение остаётся во владении вызывающего кода.
   * Уже прочитанный проект должен иметь ID выбранной БД и вид project из того же снимка.
   * null фиксирует отсутствие проекта в полном составе; пропуск аргумента оставляет ленивое чтение.
   * Декодирование отложено до обращения, чтобы doctor мог собрать ошибки всех карточек.
   */
  constructor(db: ProjectDatabase, project?: Readonly<EntityRecord> | null) {
    this.db = db;
    this.entities = new EntityService(db);
    this.projectRecord = project;
  }

  /**
   * Разрешает пользовательскую ссылку и проверяет предметную карточку в снимке операции.
   * Отсутствие цели даёт NOT_FOUND, повреждённое содержание — CORRUPT_DATA.
   */
  get(ref: string): ProjectEntity {
    return this.decode(this.entities.get(ref));
  }

  /**
   * Возвращает единожды проверенный проект операции, используя переданную карточку без чтения БД.
   * При отсутствии переданного снимка лениво читает проект; известное отсутствие даёт NOT_FOUND,
   * повреждённое содержание — CORRUPT_DATA без подстановки пустого каталога разделов.
   */
  project(): KnowledgeRecord<"project"> {
    if (this.projectRecord === null) {
      throw new RelayError("NOT_FOUND", entityMessages.recordNotFound, 3, {
        ref: this.db.projectId,
        kind: "project",
      });
    }
    return (this.decodedProject ??= decodeKnowledge(
      this.projectRecord ?? this.entities.get(this.db.projectId, "project"),
      "project",
    ));
  }

  /**
   * Декодирует сохранённую запись по виду, не исправляя её и не выполняя запись в БД.
   * Проверенный переданный проект переиспользуется; остальные проекты проверяются независимо.
   * Все документы reader используют единственный лениво построенный индекс разделов проекта.
   * Неизвестный раздел отклоняется, ссылка на легально удалённый раздел остаётся допустимой.
   */
  decode(record: Readonly<EntityRecord>): ProjectEntity {
    switch (record.kind) {
      case "project":
        return record === this.projectRecord ? this.project() : decodeKnowledge(record, "project");
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
        this.sections ??= indexDocumentSections(this.project());
        validateDocumentSection(document, this.sections);
        return document;
      }
      default:
        return decodeKnowledge(record, record.kind);
    }
  }
}
