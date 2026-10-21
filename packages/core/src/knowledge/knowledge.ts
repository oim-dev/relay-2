import {
  validateActor,
  validateEntityPageRequest,
  type DocumentLinks,
  type DocumentSections,
  type EntityKind,
  type EntityPage,
  type EntityPageRequest,
  type KnowledgeKind,
  type KnowledgeRecord,
  type WriteOptions,
} from "@relay/contracts";
import type { ProjectDatabase } from "@relay/storage";
import { EntityService } from "../entities/entities";
import { parseDocumentSectionChange } from "./document-section-input";
import { changeDocumentSections, requireActiveDocumentSection } from "./document-sections";
import type { DocumentSectionAction } from "./document-sections.types";
import { KnowledgeApplications } from "./knowledge-applications";
import { DOCUMENT_SECTION_ACTIONS } from "./knowledge-constants";
import { decodeKnowledge } from "./knowledge-data";
import { parseKnowledgeFilters } from "./knowledge-filters";
import {
  parseKnowledgeCreation,
  parseKnowledgeLink,
  parseKnowledgeUpdate,
  parseParticipationTargets,
} from "./knowledge-input";
import { KnowledgeParticipation } from "./knowledge-participation";
import { KnowledgeQueries } from "./knowledge-queries";
import { changeKnowledgeRelation, resolveKnowledgeRelations } from "./knowledge-relations";
import {
  requireEmptyProduct,
  requireKnowledgeRevision,
  sameKnowledgeCollection,
} from "./knowledge-rules";
import { knowledgeMessages } from "./knowledge.messages";
import type {
  KnowledgeCreation,
  KnowledgeInput,
  KnowledgeLinkOptions,
  KnowledgeUpdate,
} from "./knowledge.types";
import {
  invalidKnowledge,
  knowledgeChoice,
  knowledgeKind,
  knowledgeObject,
  knowledgeText,
  validateKnowledgeWrite,
} from "./knowledge-validation";

/**
 * Владелец транзакционных сценариев знаний: проверяет CAS до no-op и удерживает
 * единый снимок чтения либо замок записи на время разрешения ссылок и предметных шагов.
 */
export class KnowledgeService {
  /* Соединение проекта; жизненным циклом и закрытием владеет вызывающая сторона. */
  private readonly db: ProjectDatabase;
  /* Внутренний механизм записи и общего разрешения адресов. */
  private readonly entities: EntityService;
  /* Чтение, фильтрация и эффективный раздел документа в текущем снимке. */
  private readonly queries: KnowledgeQueries;
  /* Совместные изменения приложения и его доски. */
  private readonly applications: KnowledgeApplications;
  /* Состав активных и исторических реализаций приложений. */
  private readonly participation: KnowledgeParticipation;

  /**
   * Привязывает сценарии к соединению без открытия дополнительных ресурсов.
   */
  constructor(db: ProjectDatabase) {
    this.db = db;
    this.entities = new EntityService(db);
    this.queries = new KnowledgeQueries(db);
    this.applications = new KnowledgeApplications(this.entities, this.queries);
    this.participation = new KnowledgeParticipation(this.entities, this.queries);
  }

  /**
   * Возвращает полную проверенную запись одного снимка; исторически снятый раздел проецируется в null.
   * Отсутствие записи даёт NOT_FOUND, повреждение содержания или неизвестный раздел — CORRUPT_DATA.
   */
  get<K extends EntityKind>(
    entityKind: K,
    ref?: string,
  ): KnowledgeRecord<Extract<K, KnowledgeKind>>;
  /**
   * Разрешение адреса, содержание и разделы читаются из одного согласованного снимка.
   */
  get(entityKind: EntityKind, ref?: string): KnowledgeRecord {
    const selected = knowledgeKind(entityKind);
    return this.db.snapshot(() =>
      this.queries.projectDocument(
        this.queries.resolve(ref ?? this.queries.singletonRef(selected), selected),
      ),
    );
  }

  /**
   * Возвращает отфильтрованный набор; стоимость чтения зависит от всего набора выбранного вида.
   * Фильтры, их ссылки и содержание проверяются в одном снимке; повреждение не скрывается фильтром.
   */
  list<K extends EntityKind>(
    entityKind: K,
    filters?: KnowledgeInput,
  ): KnowledgeRecord<Extract<K, KnowledgeKind>>[];
  /**
   * Проверяет фильтры, разрешает их ссылки и декодирует записи в одном снимке.
   * Повреждение содержания не скрывается несовпадением фильтра.
   */
  list(entityKind: EntityKind, filters: KnowledgeInput = {}): KnowledgeRecord[] {
    const selected = knowledgeKind(entityKind);
    return this.db.snapshot(() =>
      this.queries.list(selected, parseKnowledgeFilters(selected, filters)),
    );
  }

  /**
   * Возвращает окно и count одного снимка с порядком request.sort.
   * Переданный filters.sort должен совпадать с порядком окна.
   * Без предметных фильтров читает ограниченное SQL-окно; иначе загружает весь набор с телами
   * до фильтрации. Разделы документов проецируются по тому же снимку.
   */
  listPage<K extends EntityKind>(
    entityKind: K,
    filters: KnowledgeInput,
    request: EntityPageRequest,
  ): EntityPage<KnowledgeRecord<Extract<K, KnowledgeKind>>>;
  /**
   * Проверяет форму окна и фильтров до выбора SQL либо предметного пути чтения.
   */
  listPage(
    entityKind: EntityKind,
    filters: KnowledgeInput,
    request: EntityPageRequest,
  ): EntityPage<KnowledgeRecord> {
    const selected = knowledgeKind(entityKind);
    const input = knowledgeObject(filters, knowledgeMessages.filtersLabel);
    validateEntityPageRequest(request);
    if (Object.hasOwn(input, "sort") && input.sort !== request.sort) {
      invalidKnowledge(knowledgeMessages.sortMismatch);
    }
    return this.db.snapshot(() => {
      const parsed = Object.keys(input).some((field) => field !== "sort")
        ? parseKnowledgeFilters(selected, { ...input, sort: request.sort })
        : undefined;
      return this.queries.listPage(selected, request, parsed);
    });
  }

  /**
   * Создаёт знания атомарно: приложение вместе с доской, реализацию вместе с составом приложения.
   * Создание реализации меняет также ревизию приложения. Пустой паспорт продукта заполняется
   * однократно; повтор даёт ALREADY_EXISTS. Проект и доска отдельно не создаются.
   */
  create<K extends EntityKind>(
    entityKind: K,
    input: KnowledgeInput,
    actor: string,
  ): KnowledgeRecord<Extract<K, KnowledgeKind>>;
  /**
   * Проверяет внешний ввод и ссылки под общим замком записи, откатывая все предметные шаги при отказе.
   */
  create(entityKind: EntityKind, input: KnowledgeInput, actor: string): KnowledgeRecord {
    const selected = knowledgeKind(entityKind);
    return this.db.transaction(() => {
      validateActor(actor);
      return this.createChecked(parseKnowledgeCreation(selected, input), actor);
    });
  }

  /**
   * Выполняет предметный шаг создания для проверенной команды внутри общей транзакции.
   */
  private createChecked(command: KnowledgeCreation, actor: string): KnowledgeRecord {
    switch (command.kind) {
      case "product": {
        const current = this.queries.resolve(this.queries.singletonRef("product"), "product");
        requireEmptyProduct(current);
        return decodeKnowledge(
          this.entities.update(
            current.id,
            "product",
            { ...command.data },
            { actor, ifRevision: current.revision },
          ),
          "product",
        );
      }
      case "application":
        return this.applications.create(command.data, actor);
      case "implementation":
        return this.participation.create(command.application, command.target, command.data, actor);
      case "feature":
        return decodeKnowledge(
          this.entities.create("feature", "FEATURE", { ...command.data }, actor),
          "feature",
        );
      case "scenario": {
        const feature = this.queries.resolve(command.feature, "feature");
        return decodeKnowledge(
          this.entities.create(
            "scenario",
            "SCENARIO",
            { ...command.data, featureId: feature.id },
            actor,
          ),
          "scenario",
        );
      }
      case "document": {
        const sections = this.queries.sectionIndex();
        requireActiveDocumentSection(command.data.sectionId, sections);
        const relations = resolveKnowledgeRelations(command.relations, this.queries);
        return this.queries.projectDocument(
          this.entities.create("document", "DOC", { ...command.data, relations }, actor),
          sections,
        );
      }
    }
  }

  /**
   * Изменяет только переданные поля под CAS указанной записи, включая no-op.
   * Имя приложения атомарно меняет имя доски под её собственной ревизией.
   * Равные данные сохраняют автора, ревизию и поколение; устаревшая ревизия даёт REVISION_CONFLICT.
   */
  update<K extends EntityKind>(
    entityKind: K,
    ref: string | undefined,
    input: KnowledgeInput,
    write: WriteOptions,
  ): KnowledgeRecord<Extract<K, KnowledgeKind>>;
  /**
   * Проверяет ревизию владельца до разбора изменения и любых предметных записей.
   */
  update(
    entityKind: EntityKind,
    ref: string | undefined,
    input: KnowledgeInput,
    write: WriteOptions,
  ): KnowledgeRecord {
    const selected = knowledgeKind(entityKind);
    return this.db.transaction(() => {
      validateKnowledgeWrite(write);
      if (selected === "board") {
        invalidKnowledge(knowledgeMessages.boardUpdate);
      }
      const current = this.queries.resolve(ref ?? this.queries.singletonRef(selected), selected);
      requireKnowledgeRevision(current, write.ifRevision);
      return this.updateChecked(current, parseKnowledgeUpdate(selected, input), write);
    });
  }

  /**
   * Применяет типизированный patch внутри внешней транзакции после CAS владельца.
   * Документ сохраняет исторический sectionId, если новый раздел явно не передан.
   */
  private updateChecked(
    current: KnowledgeRecord,
    command: KnowledgeUpdate,
    write: WriteOptions,
  ): KnowledgeRecord {
    if (command.kind === "application") {
      return this.applications.update(decodeKnowledge(current, "application"), command.data, write);
    }
    if (command.kind === "document") {
      const document = decodeKnowledge(current, "document");
      const sections = this.queries.sectionIndex();
      if (command.data.sectionId !== undefined) {
        requireActiveDocumentSection(command.data.sectionId, sections);
      }
      const relations =
        command.relations === undefined
          ? undefined
          : resolveKnowledgeRelations(command.relations, this.queries, document);
      return this.queries.projectDocument(
        this.entities.update(
          current.id,
          "document",
          {
            ...command.data,
            ...(relations === undefined ? {} : { relations }),
          },
          write,
        ),
        sections,
      );
    }
    return this.queries.projectDocument(
      this.entities.update(current.id, command.kind, { ...command.data }, write),
    );
  }

  /**
   * Переименовывает запись под её CAS, включая no-op; прежний ключ остаётся алиасом.
   * Чужой адрес даёт CONFLICT; при прежнем ключе автор, ревизия и поколение сохраняются.
   */
  rename<K extends EntityKind>(
    entityKind: K,
    ref: string,
    key: string,
    write: WriteOptions,
  ): KnowledgeRecord<Extract<K, KnowledgeKind>>;
  /**
   * Проверяет CAS до no-op и возвращает проекцию записи из той же транзакции.
   */
  rename(entityKind: EntityKind, ref: string, key: string, write: WriteOptions): KnowledgeRecord {
    const selected = knowledgeKind(entityKind);
    return this.db.transaction(() => {
      validateKnowledgeWrite(write);
      const current = this.queries.resolve(ref, selected);
      requireKnowledgeRevision(current, write.ifRevision);
      knowledgeText(key, "key", true);
      return this.queries.projectDocument(this.entities.rename(current.id, selected, key, write));
    });
  }

  /**
   * Читает разделы и ревизию проекта-владельца из одного снимка; seed без разделов даёт пустой список.
   */
  documentSections(): DocumentSections {
    return this.db.snapshot(() => {
      const project = this.queries.project();
      return {
        project: project.key,
        revision: project.revision,
        items: project.data.documentSections ?? [],
      };
    });
  }

  /**
   * Читает проверенные отношения и ревизию документа из одного снимка без содержания целей.
   */
  documentLinks(ref: string): DocumentLinks {
    return this.db.snapshot(() => {
      const document = this.queries.resolve(ref, "document");
      return { ref: document.key, revision: document.revision, items: document.data.relations };
    });
  }

  /**
   * Меняет разделы под CAS проекта, включая no-op. Удаление навсегда резервирует ID,
   * не переписывая документы; эффективный раздел проецируется при чтении.
   * Проверка состояния, резервирование и запись атомарны.
   */
  changeSection(
    action: DocumentSectionAction,
    input: KnowledgeInput,
    write: WriteOptions,
  ): KnowledgeRecord<"project"> {
    return this.db.transaction(() => {
      const selected = knowledgeChoice(action, DOCUMENT_SECTION_ACTIONS, "action");
      validateKnowledgeWrite(write);
      const project = this.queries.project();
      requireKnowledgeRevision(project, write.ifRevision);
      const next = changeDocumentSections(project, parseDocumentSectionChange(selected, input));
      if (sameKnowledgeCollection(next.documentSections, project.data.documentSections ?? [])) {
        return project;
      }
      return decodeKnowledge(
        this.entities.update(project.id, "project", { ...next }, write),
        "project",
      );
    });
  }

  /**
   * Меняет одну пару цель + тип под CAS документа. Новая связь со снятой реализацией запрещена,
   * прежнюю можно изменить или снять. Повтор и снятие отсутствующей пары — no-op только
   * при актуальной ревизии; разрешение цели и запись атомарны.
   */
  linkDocument(
    ref: string,
    target: string,
    write: KnowledgeLinkOptions,
  ): KnowledgeRecord<"document"> {
    return this.db.transaction(() => {
      validateKnowledgeWrite(write, ["remove", "type", "description"]);
      const document = this.queries.resolve(ref, "document");
      requireKnowledgeRevision(document, write.ifRevision);
      const change = parseKnowledgeLink(write);
      const next = changeKnowledgeRelation(document, this.queries.resolve(target), change);
      if (sameKnowledgeCollection(next, document.data.relations)) {
        return this.queries.projectDocument(document);
      }
      return this.queries.projectDocument(
        decodeKnowledge(
          this.entities.update(
            document.id,
            "document",
            { relations: next },
            { actor: write.actor, ifRevision: write.ifRevision },
          ),
          "document",
        ),
      );
    });
  }

  /**
   * Заменяет участие под CAS приложения, не отдельных реализаций, включая no-op.
   * Проверки FI/SI и запись состава атомарны. Снятие сохраняет ID, ключи и тексты;
   * повторное включение возвращает историческую реализацию.
   * Входной массив ссылок не изменяется; пустой массив снимает всё участие.
   */
  replaceParticipation(
    application: string,
    targets: readonly string[],
    write: WriteOptions,
  ): KnowledgeRecord<"application"> {
    return this.db.transaction(() => {
      validateKnowledgeWrite(write);
      const current = this.queries.resolve(application, "application");
      requireKnowledgeRevision(current, write.ifRevision);
      return this.participation.replace(current, parseParticipationTargets(targets), write.actor);
    });
  }
}
