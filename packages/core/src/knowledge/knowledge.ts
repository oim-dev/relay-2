import {
  validateEntityPageRequest,
  type CommandExecutionContext,
  type DocumentLinks,
  type DocumentSections,
  type EntityKind,
  type EntityPage,
  type EntityPageRequest,
  type KnowledgeKind,
  type KnowledgeRecord,
  type CommandWriteOptions,
} from "@relay/contracts";
import type { ProjectStore } from "@relay/storage";
import { executeEntityCommand } from "../commands/command-facade";
import type { DocumentSectionAction } from "./document-sections.types";
import { DOCUMENT_SECTION_ACTIONS } from "./knowledge-constants";
import { decodeKnowledge } from "./knowledge-data";
import { compareKnowledge, parseKnowledgeFilters } from "./knowledge-filters";
import { KnowledgeQueries } from "./knowledge-queries";
import { knowledgeMessages } from "./knowledge.messages";
import type {
  KnowledgeInput,
  KnowledgeLinkOptions,
  ApplicationParticipation,
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
 * Публичные чтения знаний используют согласованный sync snapshot; все writers проходят
 * через единый async executor с явной загрузкой, чистым расчётом и guarded commit.
 */
export class KnowledgeService {
  /* Открытый проект; жизненным циклом соединения владеет вызывающая сторона. */
  private readonly db: ProjectStore;
  /* Клиентские ожидания адресов и переносимый token владельца по умолчанию. */
  private readonly execution: CommandExecutionContext;
  /* Оптимизированные синхронные чтения и пользовательская проекция разделов. */
  private readonly queries: KnowledgeQueries;

  /**
   * Привязывает API к открытому проекту без дополнительных ресурсов или чтений.
   */
  constructor(db: ProjectStore, execution: CommandExecutionContext = {}) {
    this.db = db;
    this.execution = execution;
    this.queries = new KnowledgeQueries(db);
  }

  /**
   * Возвращает проверенную запись одного снимка; снятый раздел проецируется в null.
   */
  get<K extends EntityKind>(
    entityKind: K,
    ref?: string,
  ): KnowledgeRecord<Extract<K, KnowledgeKind>>;
  /**
   * Разрешает адрес и декодирует содержание с каталогом разделов одного snapshot.
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
   * Декодирует и фильтрует полный набор выбранного вида в одном снимке.
   */
  list<K extends EntityKind>(
    entityKind: K,
    filters?: KnowledgeInput,
  ): KnowledgeRecord<Extract<K, KnowledgeKind>>[];
  /**
   * Повреждение содержания не скрывается несовпадением фильтра.
   */
  list(entityKind: EntityKind, filters: KnowledgeInput = {}): KnowledgeRecord[] {
    const selected = knowledgeKind(entityKind);
    return this.db.snapshot(() =>
      this.queries.list(selected, parseKnowledgeFilters(selected, filters)),
    );
  }

  /**
   * Возвращает окно и count одного снимка; предметный фильтр требует полного набора вида.
   */
  listPage<K extends EntityKind>(
    entityKind: K,
    filters: KnowledgeInput,
    request: EntityPageRequest,
  ): EntityPage<KnowledgeRecord<Extract<K, KnowledgeKind>>>;
  /**
   * Без предметного фильтра использует ограниченное SQL-окно с request.sort.
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
   * Создаёт знания атомарно с неявными доской и составом участия; паспорт заполняется однократно.
   */
  create<K extends EntityKind>(
    entityKind: K,
    input: KnowledgeInput,
    actor: string,
  ): Promise<KnowledgeRecord<Extract<K, KnowledgeKind>>>;
  /**
   * Точечный create и batch используют один handler; отказ не расходует ключи и не оставляет записей.
   */
  async create(
    entityKind: EntityKind,
    input: KnowledgeInput,
    actor: string,
  ): Promise<KnowledgeRecord> {
    const kind = knowledgeKind(entityKind);
    if (kind === "project" || kind === "board") {
      invalidKnowledge(
        kind === "project" ? knowledgeMessages.projectCreation : knowledgeMessages.boardCreation,
      );
    }
    return decodeKnowledge(
      await executeEntityCommand(this.db, { op: `${kind}.create`, input }, actor, this.execution),
      kind,
    );
  }

  /**
   * Меняет переданные поля под исходной ревизией или переносимым token до no-op.
   * Если заданы оба условия, проверяются оба; имя приложения синхронизирует доску.
   */
  update<K extends EntityKind>(
    entityKind: K,
    ref: string | undefined,
    input: KnowledgeInput,
    write: CommandWriteOptions,
  ): Promise<KnowledgeRecord<Extract<K, KnowledgeKind>>>;
  /**
   * Передаёт исходные условия единому исполнителю без чтения свежего CAS в фасаде.
   */
  async update(
    entityKind: EntityKind,
    ref: string | undefined,
    input: KnowledgeInput,
    write: CommandWriteOptions,
  ): Promise<KnowledgeRecord> {
    const kind = knowledgeKind(entityKind);
    validateKnowledgeWrite(write, [], this.execution.expectedVersion);
    if (kind === "board") {
      invalidKnowledge(knowledgeMessages.boardUpdate);
    }
    return decodeKnowledge(
      await executeEntityCommand(
        this.db,
        {
          op: `${kind}.update`,
          ...this.commandRef(kind, ref),
          input,
          ...(write.ifRevision === undefined ? {} : { ifRevision: write.ifRevision }),
          ...(write.expectedVersion === undefined
            ? {}
            : { expectedVersion: write.expectedVersion }),
        },
        write.actor,
        this.execution,
      ),
      kind,
    );
  }

  /**
   * Переименовывает под ревизией и/или переносимым token, сохраняя прежний ключ алиасом.
   * Равный ключ не меняет метаданные; исходные условия проверяются и при no-op.
   */
  rename<K extends EntityKind>(
    entityKind: K,
    ref: string | undefined,
    key: string,
    write: CommandWriteOptions,
  ): Promise<KnowledgeRecord<Extract<K, KnowledgeKind>>>;
  /**
   * Singleton выбирается без ref; остальные виды требуют непустой пользовательский адрес.
   */
  async rename(
    entityKind: EntityKind,
    ref: string | undefined,
    key: string,
    write: CommandWriteOptions,
  ): Promise<KnowledgeRecord> {
    const kind = knowledgeKind(entityKind);
    validateKnowledgeWrite(write, [], this.execution.expectedVersion);
    return decodeKnowledge(
      await executeEntityCommand(
        this.db,
        {
          op: `${kind}.rename`,
          ...this.commandRef(kind, ref),
          input: { key },
          ...(write.ifRevision === undefined ? {} : { ifRevision: write.ifRevision }),
          ...(write.expectedVersion === undefined
            ? {}
            : { expectedVersion: write.expectedVersion }),
        },
        write.actor,
        this.execution,
      ),
      kind,
    );
  }

  /**
   * Сохраняет явный адрес, включая singleton; его разрешает общий async loader.
   */
  private commandRef(kind: KnowledgeKind, ref: string | undefined): { readonly ref?: string } {
    if (ref !== undefined) {
      return { ref: knowledgeText(ref, "ref", true) };
    }
    if (kind === "project" || kind === "product") {
      return {};
    }
    return { ref: knowledgeText(ref, "ref", true) };
  }

  /**
   * Возвращает разделы и ревизию проекта из одного снимка; seed без разделов даёт пустой массив.
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
   * Читает проверенные отношения и ревизию документа без содержания его целей.
   */
  documentLinks(ref: string): DocumentLinks {
    return this.db.snapshot(() => {
      const document = this.queries.resolve(ref, "document");
      return { ref: document.key, revision: document.revision, items: document.data.relations };
    });
  }

  /**
   * Читает только историю выбранного приложения и полностью сверяет активные ID с владельцем.
   */
  participation(ref: string): ApplicationParticipation {
    return this.db.snapshot(() => {
      const application = this.queries.resolve(ref, "application");
      const items = this.queries
        .applicationImplementations(application)
        .filter((record) => record.data.active);
      return {
        application: application.key,
        revision: application.revision,
        items: items.sort((left, right) => compareKnowledge(left, right, "key")),
      };
    });
  }

  /**
   * Меняет разделы под исходной ревизией и/или token проекта; снятие резервирует ID навсегда.
   */
  async changeSection(
    action: DocumentSectionAction,
    input: KnowledgeInput,
    write: CommandWriteOptions,
  ): Promise<KnowledgeRecord<"project">> {
    const selected = knowledgeChoice(action, DOCUMENT_SECTION_ACTIONS, "action");
    validateKnowledgeWrite(write, [], this.execution.expectedVersion);
    return decodeKnowledge(
      await executeEntityCommand(
        this.db,
        {
          op: `document.section.${selected}`,
          input,
          ...(write.ifRevision === undefined ? {} : { ifRevision: write.ifRevision }),
          ...(write.expectedVersion === undefined
            ? {}
            : { expectedVersion: write.expectedVersion }),
        },
        write.actor,
        this.execution,
      ),
      "project",
    );
  }

  /**
   * Меняет пару цель + тип под ревизией и/или token документа; новая связь со снятой FI/SI запрещена.
   */
  async linkDocument(
    ref: string,
    target: string,
    write: KnowledgeLinkOptions,
  ): Promise<KnowledgeRecord<"document">> {
    validateKnowledgeWrite(
      write,
      ["remove", "type", "description"],
      this.execution.expectedVersion,
    );
    if (Object.hasOwn(write, "remove") && typeof write.remove !== "boolean") {
      invalidKnowledge(knowledgeMessages.boolean("remove"));
    }
    if (write.remove && write.description !== undefined) {
      invalidKnowledge(knowledgeMessages.unlinkDescription);
    }
    return decodeKnowledge(
      await executeEntityCommand(
        this.db,
        {
          op: `document.${write.remove ? "unlink" : "link"}`,
          ref,
          ...(write.ifRevision === undefined ? {} : { ifRevision: write.ifRevision }),
          ...(write.expectedVersion === undefined
            ? {}
            : { expectedVersion: write.expectedVersion }),
          input: {
            target,
            ...(write.type === undefined ? {} : { type: write.type }),
            ...(write.description === undefined ? {} : { description: write.description }),
          },
        },
        write.actor,
        this.execution,
      ),
      "document",
    );
  }

  /**
   * Заменяет участие под ревизией и/или token приложения; снятые ID/ключи/тексты сохраняются.
   */
  async replaceParticipation(
    application: string,
    targets: readonly string[],
    write: CommandWriteOptions,
  ): Promise<KnowledgeRecord<"application">> {
    validateKnowledgeWrite(write, [], this.execution.expectedVersion);
    return decodeKnowledge(
      await executeEntityCommand(
        this.db,
        {
          op: "application.participation.replace",
          ref: application,
          input: { targets },
          ...(write.ifRevision === undefined ? {} : { ifRevision: write.ifRevision }),
          ...(write.expectedVersion === undefined
            ? {}
            : { expectedVersion: write.expectedVersion }),
        },
        write.actor,
        this.execution,
      ),
      "application",
    );
  }
}
