import {
  RelayError,
  type EntityKind,
  type EntityPage,
  type EntityPageRequest,
  type EntityRecord,
  type KnowledgeKind,
  type KnowledgeRecord,
} from "@relay/contracts";
import type { ProjectDatabase } from "@relay/storage";
import { EntityService } from "../entities/entities";
import { pageEntities } from "../entities/entity-page";
import { indexDocumentSections, projectDocumentSection } from "./document-sections";
import type { DocumentSectionIndex } from "./document-sections.types";
import { decodeKnowledge, isKnowledgeKind } from "./knowledge-data";
import { compareKnowledge, matchesKnowledge, resolveKnowledgeFilters } from "./knowledge-filters";
import type { KnowledgeFilters } from "./knowledge-filters.types";
import { knowledgeMessages } from "./knowledge.messages";
import type { KnowledgeReference } from "./knowledge.types";
import { invalidKnowledge, knowledgeKind, knowledgeText } from "./knowledge-validation";

/**
 * Чтение и проекция знаний внутри снимка или транзакции вызывающего сценария.
 * Индекс разделов не кешируется между операциями; списки строят его один раз на набор.
 */
export class KnowledgeQueries {
  /* Общий владелец правил разрешения адресов; соединением владеет вызывающая сторона. */
  private readonly entities: EntityService;
  /* Соединение проекта; методы не открывают самостоятельный внешний снимок. */
  private readonly db: ProjectDatabase;

  /**
   * Привязывает чтение к переданному соединению, не меняя его жизненный цикл.
   */
  constructor(db: ProjectDatabase) {
    this.db = db;
    this.entities = new EntityService(db);
  }

  /**
   * Возвращает постоянный адрес singleton; для остальных видов ссылка обязательна.
   */
  singletonRef(kind: KnowledgeKind): string {
    if (kind === "project") {
      return this.db.projectId;
    }
    if (kind === "product") {
      return "PRODUCT";
    }
    return invalidKnowledge(knowledgeMessages.reference(kind));
  }

  /**
   * Разрешает ссылку и проверяет полное содержание знания ожидаемого вида.
   */
  resolve<K extends KnowledgeKind>(ref: string, expectedKind: K): KnowledgeRecord<K>;
  /**
   * Разрешает произвольную цель; чужие предметные виды остаются данными их владельца.
   */
  resolve(ref: string, expectedKind?: EntityKind): KnowledgeReference;
  /**
   * Использует общий EntityService для ключей и алиасов, затем декодирует знания.
   */
  resolve(ref: string, expectedKind?: EntityKind): KnowledgeReference {
    const record = this.entities.get(knowledgeText(ref, "ref", true), expectedKind);
    if (isKnowledgeKind(record.kind)) {
      return decodeKnowledge(record, record.kind);
    }
    return { ...record, kind: record.kind };
  }

  /**
   * Читает проверенный проект-владелец разделов в текущем снимке.
   */
  project(): KnowledgeRecord<"project"> {
    return this.resolve(this.db.projectId, "project");
  }

  /**
   * Строит индекс активных и исторических разделов по текущему снимку.
   */
  sectionIndex(): DocumentSectionIndex {
    return indexDocumentSections(this.project());
  }

  /**
   * Проецирует эффективный раздел, сохраняя конкретный вид проверенной записи.
   */
  projectDocument<K extends KnowledgeKind>(
    entity: KnowledgeRecord<K>,
    sections?: DocumentSectionIndex,
  ): KnowledgeRecord<K>;
  /**
   * Декодирует сырую запись и возвращает документ с эффективным разделом.
   */
  projectDocument(entity: EntityRecord, sections?: DocumentSectionIndex): KnowledgeRecord;
  /**
   * Проверяет данные до проекции; неизвестный раздел не превращается в null.
   */
  projectDocument(entity: EntityRecord, sections?: DocumentSectionIndex): KnowledgeRecord {
    const checked = decodeKnowledge(entity, knowledgeKind(entity.kind));
    if (checked.kind !== "document") {
      return checked;
    }
    return projectDocumentSection(checked, sections ?? this.sectionIndex());
  }

  /**
   * Читает историю приложения и сверяет активные ID с уже прочитанным владельцем.
   * Несогласованность, включая отфильтрованную повреждённую обратную ссылку, даёт CORRUPT_DATA.
   * Чужие карточки не загружаются; владелец и выборка принадлежат снимку вызывающего сценария.
   */
  applicationImplementations(
    application: Readonly<KnowledgeRecord<"application">>,
  ): KnowledgeRecord<"implementation">[] {
    const records = this.db
      .listByField("implementation", "applicationId", application.id)
      .map((record) => decodeKnowledge(record, "implementation"));
    const activeIds = new Set(
      records.filter((record) => record.data.active).map((record) => record.id),
    );
    if (
      activeIds.size !== application.data.implementationIds.length ||
      application.data.implementationIds.some((id) => !activeIds.has(id))
    ) {
      throw new RelayError("CORRUPT_DATA", knowledgeMessages.participationMismatch, 1, {
        id: application.id,
      });
    }
    return records;
  }

  /**
   * Фильтрует полный набор после декодирования и единой проекции разделов снимка.
   */
  list(kind: KnowledgeKind, filters: KnowledgeFilters): KnowledgeRecord[] {
    return this.filtered(kind, filters).sort((left, right) =>
      compareKnowledge(left, right, filters.sort),
    );
  }

  /**
   * Декодирует и фильтрует полный набор без предварительной сортировки перед окном.
   */
  private filtered(kind: KnowledgeKind, filters: KnowledgeFilters): KnowledgeRecord[] {
    const resolved = resolveKnowledgeFilters(kind, filters, this);
    const sections = kind === "document" ? this.sectionIndex() : undefined;
    return this.entities
      .list(kind)
      .map((record) => this.projectDocument(record, sections))
      .filter((record) => matchesKnowledge(record, resolved));
  }

  /**
   * Читает ограниченное SQL-окно без предметных фильтров; иначе фильтрует полный набор
   * и сортирует его ровно один раз окончательным компаратором страницы.
   * Окно, count и разделы должны читаться под единым внешним снимком.
   */
  listPage(
    kind: KnowledgeKind,
    request: EntityPageRequest,
    filters?: KnowledgeFilters,
  ): EntityPage<KnowledgeRecord> {
    if (filters !== undefined) {
      return pageEntities(this.filtered(kind, filters), request);
    }
    const page = this.db.listPage(kind, request);
    const sections = kind === "document" ? this.sectionIndex() : undefined;
    return {
      total: page.total,
      items: page.items.map((record) => this.projectDocument(record, sections)),
    };
  }
}
