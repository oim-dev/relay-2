import {
  RelayError,
  APPLICATION_TYPES,
  DOCUMENT_KINDS,
  DOCUMENT_RELATION_TYPES,
  DOCUMENT_STATUSES,
  DOCUMENT_TARGET_KINDS,
  IMPLEMENTATION_STATUSES,
  KNOWLEDGE_KINDS,
  validateActor,
  validateEntityPageRequest,
  type DocumentLinks,
  type DocumentRelation,
  type DocumentSection,
  type DocumentSections,
  type EntityPage,
  type EntityPageRequest,
  type KnowledgeKind,
  type KnowledgeRecord,
  type EntityKind,
  type EntityRecord,
  type WriteOptions,
} from "@relay/contracts";
import type { ProjectDatabase } from "@relay/storage";
import { EntityService } from "./entities";
import { pageEntities } from "./entity-page";
import { decodeKnowledge, isKnowledgeKind } from "./knowledge-data";
import {
  indexDocumentSections,
  projectDocumentSection,
  type DocumentSectionIndex,
} from "./document-sections";

type Fields = Record<string, unknown>;
type Section = DocumentSection;
type Relation = DocumentRelation;
const documentKinds = DOCUMENT_KINDS;
const documentStatuses = DOCUMENT_STATUSES;
const relationKinds = DOCUMENT_TARGET_KINDS;
const textFields = ["name", "summary", "description"] as const;
const writable: Record<KnowledgeKind, readonly string[]> = {
  project: ["name", "slug"],
  product: textFields,
  feature: textFields,
  scenario: textFields,
  application: [...textFields, "type"],
  implementation: ["title", "description", "status"],
  document: [
    "name",
    "summary",
    "body",
    "documentKind",
    "documentStatus",
    "sectionId",
    "pinned",
    "relations",
    "targets",
  ],
  board: [],
};
const createOnly: Partial<Record<KnowledgeKind, string[]>> = {
  scenario: ["feature", "featureId"],
  application: ["slug", "prefix"],
  implementation: ["application", "applicationId", "target"],
};

function invalid(message: string): never {
  throw new RelayError("INVALID_ARGUMENT", message, 2);
}

function object(value: unknown, label = "Ввод"): Fields {
  if (!value || typeof value !== "object" || Array.isArray(value))
    invalid(`${label}: требуется объект`);
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null)
    invalid(`${label}: требуется обычный объект`);
  return value as Fields;
}

function fields(value: unknown, allowed: readonly string[], label = "Ввод"): Fields {
  const input = object(value, label);
  for (const key of Object.keys(input)) {
    if (!allowed.includes(key)) invalid(`${label}: неизвестное или неизменяемое поле ${key}`);
  }
  return input;
}

function text(value: unknown, label: string, nonempty = false): string {
  if (typeof value !== "string" || (nonempty && !value.trim()))
    invalid(`${label}: требуется ${nonempty ? "непустая " : ""}строка`);
  return value;
}

function name(value: unknown, label = "name"): string {
  const result = text(value, label, true);
  if (/[\r\n\u2028\u2029]/u.test(result)) invalid(`${label}: название должно занимать одну строку`);
  return result;
}

function projectName(value: unknown): string {
  const result = text(value, "name", true).trim();
  if (result.length > 120 || /[\p{Cc}\u2028\u2029]/u.test(result))
    invalid("Название проекта: 1–120 символов однострочного текста без управляющих символов");
  return result;
}

function enumeration<T extends string>(value: unknown, values: readonly T[], label: string): T {
  if (typeof value !== "string" || !values.includes(value as T))
    invalid(`${label}: допустимы ${values.join(", ")}`);
  return value as T;
}

function boolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") invalid(`${label}: требуется boolean`);
  return value;
}

function slug(value: unknown): string {
  const result = text(value, "slug", true);
  if (
    result.length < 2 ||
    result.length > 64 ||
    result !== result.trim() ||
    !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(result)
  )
    invalid("slug: 2–64 строчные латинские буквы/цифры с одиночными дефисами между частями");
  return result;
}

function prefix(value: unknown): string {
  const result = text(value, "prefix", true);
  if (result.length > 32 || !/^[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)*$/u.test(result))
    invalid("prefix: заглавные латинские буквы, цифры и одиночные дефисы, до 32 символов");
  return result;
}

function alias(input: Fields, first: string, second: string): unknown {
  if (Object.hasOwn(input, first) && Object.hasOwn(input, second))
    invalid(`Укажите только одно из полей ${first}, ${second}`);
  return Object.hasOwn(input, first) ? input[first] : input[second];
}

function kind(value: EntityKind): KnowledgeKind {
  return enumeration(value, KNOWLEDGE_KINDS, "kind");
}

function options(value: WriteOptions, extra: string[] = []): void {
  fields(value, ["actor", "ifRevision", ...extra], "Параметры записи");
  validateActor(value.actor);
  if (!Number.isSafeInteger(value.ifRevision) || value.ifRevision < 1)
    invalid("ifRevision: требуется положительная целая ревизия");
}

function revision(entity: EntityRecord, expected: number): void {
  if (entity.revision !== expected) {
    throw new RelayError(
      "REVISION_CONFLICT",
      `Изменилась ревизия ${entity.key}; перечитайте запись и согласуйте изменение`,
      4,
      {
        id: entity.id,
        expectedRevision: expected,
        actualRevision: entity.revision,
      },
    );
  }
}

function same(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function displayName(entity: KnowledgeRecord): string {
  return entity.kind === "implementation" ? entity.data.title : (entity.data.name ?? "");
}

/** Знания и их связи: вход проверяется до записи, сохранённые данные декодируются до использования. */
export class KnowledgeService {
  private readonly entities: EntityService;

  constructor(private readonly db: ProjectDatabase) {
    this.entities = new EntityService(db);
  }

  /** Полная проверенная запись из одного снимка; удалённый раздел документа проецируется в null без записи. */
  get<K extends EntityKind>(
    entityKind: K,
    ref?: string,
  ): KnowledgeRecord<Extract<K, KnowledgeKind>>;
  get(entityKind: EntityKind, ref?: string): KnowledgeRecord {
    const selected = kind(entityKind);
    return this.db.snapshot(() =>
      this.projectDocument(this.resolve(ref ?? this.singletonRef(selected), selected)),
    );
  }

  /** Проверенный отфильтрованный набор одного снимка; повреждение данных не маскируется пустым результатом. */
  list<K extends EntityKind>(
    entityKind: K,
    filters?: Fields,
  ): KnowledgeRecord<Extract<K, KnowledgeKind>>[];
  list(entityKind: EntityKind, filters: Fields = {}): KnowledgeRecord[] {
    const selected = kind(entityKind);
    return this.db.snapshot(() => {
      const extra: Partial<Record<KnowledgeKind, string[]>> = {
        scenario: ["feature", "featureId"],
        application: ["type"],
        implementation: [
          "application",
          "applicationId",
          "feature",
          "featureId",
          "scenario",
          "scenarioId",
          "target",
          "active",
          "status",
        ],
        document: [
          "target",
          "section",
          "sectionId",
          "documentKind",
          "documentStatus",
          "status",
          "pinned",
          "archived",
        ],
        board: ["application", "applicationId"],
      };
      fields(filters, ["q", "sort", ...(extra[selected] ?? [])], "Фильтры");
      const checks: Array<(entity: EntityRecord) => boolean> = [];
      if (Object.hasOwn(filters, "q")) {
        const query = text(filters.q, "q").toLocaleLowerCase();
        checks.push((entity) =>
          [
            entity.id,
            entity.key,
            entity.data.name,
            entity.data.title,
            entity.data.summary,
            entity.data.description,
            entity.data.body,
          ].some((value) => typeof value === "string" && value.toLocaleLowerCase().includes(query)),
        );
      }
      for (const [field, fieldAlias, targetKind, stored] of [
        ["application", "applicationId", "application", "applicationId"],
        ["feature", "featureId", "feature", "featureId"],
        ["scenario", "scenarioId", "scenario", "scenarioId"],
      ] as const) {
        if (!Object.hasOwn(filters, field) && !Object.hasOwn(filters, fieldAlias)) continue;
        const target = this.resolve(
          text(alias(filters, field, fieldAlias), field, true),
          targetKind,
        );
        checks.push((entity) => entity.data[stored] === target.id);
      }
      if (Object.hasOwn(filters, "target")) {
        const target = this.resolve(text(filters.target, "target", true));
        if (selected === "implementation" && !["feature", "scenario"].includes(target.kind))
          invalid("target: требуется фича или сценарий");
        checks.push(
          selected === "document"
            ? (entity) =>
                this.relations(entity).some((relation) => relation.target.id === target.id)
            : (entity) => entity.data.targetId === target.id,
        );
      }
      for (const field of ["active", "pinned"] as const) {
        if (!Object.hasOwn(filters, field)) continue;
        const value = boolean(filters[field], field);
        checks.push((entity) => entity.data[field] === value);
      }
      if (Object.hasOwn(filters, "type")) {
        const value = enumeration(filters.type, APPLICATION_TYPES, "type");
        checks.push((entity) => entity.data.type === value);
      }
      if (Object.hasOwn(filters, "documentKind")) {
        const value = enumeration(filters.documentKind, documentKinds, "documentKind");
        checks.push((entity) => entity.data.documentKind === value);
      }
      if (Object.hasOwn(filters, "status") || Object.hasOwn(filters, "documentStatus")) {
        const value = enumeration(
          alias(filters, "status", "documentStatus"),
          selected === "document" ? documentStatuses : IMPLEMENTATION_STATUSES,
          "status",
        );
        checks.push(
          (entity) => entity.data[selected === "document" ? "documentStatus" : "status"] === value,
        );
      }
      if (Object.hasOwn(filters, "archived")) {
        const value = boolean(filters.archived, "archived");
        checks.push((entity) => (entity.data.documentStatus === "archived") === value);
      }
      if (Object.hasOwn(filters, "section") || Object.hasOwn(filters, "sectionId")) {
        const value = alias(filters, "section", "sectionId");
        const section =
          value === null || (!Object.hasOwn(filters, "sectionId") && value === "none")
            ? null
            : text(value, "section", true);
        checks.push((entity) => entity.data.sectionId === section);
      }
      const sort = Object.hasOwn(filters, "sort")
        ? enumeration(filters.sort, ["key", "title", "updated"] as const, "sort")
        : "key";
      const sectionIndex = selected === "document" ? this.sectionIndex() : undefined;
      return this.entities
        .list(selected)
        .map((entity) => this.projectDocument(entity, sectionIndex))
        .filter((entity) => checks.every((check) => check(entity)))
        .sort((left, right) => {
          const order =
            sort === "updated"
              ? right.updatedAt.localeCompare(left.updatedAt)
              : (sort === "title" ? displayName(left) : left.key).localeCompare(
                  sort === "title" ? displayName(right) : right.key,
                );
          return order || left.id.localeCompare(right.id);
        });
    });
  }

  /**
   * Окно и count одного снимка. Без предметных фильтров Storage читает только выбранные
   * записи; документы проецируются по разделам того же снимка. При q/target и остальных
   * фильтрах пока используется полный list: стоимость зависит от всего набора и его тел,
   * не от limit. Порядок задаётся request.sort; filters.sort, если передан, должен совпадать.
   */
  listPage<K extends EntityKind>(
    entityKind: K,
    filters: Fields,
    request: EntityPageRequest,
  ): EntityPage<KnowledgeRecord<Extract<K, KnowledgeKind>>>;
  listPage(
    entityKind: EntityKind,
    filters: Fields,
    request: EntityPageRequest,
  ): EntityPage<KnowledgeRecord> {
    const selected = kind(entityKind);
    object(filters, "Фильтры");
    validateEntityPageRequest(request);
    if (Object.hasOwn(filters, "sort") && filters.sort !== request.sort)
      invalid("sort фильтра не совпадает с порядком окна");
    return this.db.snapshot(() => {
      if (Object.keys(filters).some((field) => field !== "sort")) {
        const items = this.list(selected, { ...filters, sort: request.sort });
        return pageEntities(items, request);
      }
      const page = this.db.listPage(selected, request);
      const sections = selected === "document" ? this.sectionIndex() : undefined;
      return {
        total: page.total,
        items: page.items.map((entity) => this.projectDocument(entity, sections)),
      };
    });
  }

  /**
   * Создаёт знания атомарно. Приложение создаётся вместе с доской; создание реализации
   * обновляет состав и ревизию приложения под тем же замком. Пустой паспорт продукта
   * заполняется один раз, повторное создание — ALREADY_EXISTS. Проект/доску отдельно создать нельзя.
   */
  create<K extends EntityKind>(
    entityKind: K,
    input: Fields,
    actor: string,
  ): KnowledgeRecord<Extract<K, KnowledgeKind>>;
  create(entityKind: EntityKind, input: Fields, actor: string): KnowledgeRecord {
    const selected = kind(entityKind);
    return this.db.transaction(() => {
      validateActor(actor);
      if (selected === "project") invalid("Проект создаётся при инициализации базы");
      if (selected === "board") invalid("Доски создаются только вместе с проектом или приложением");
      const data = this.prepare(selected, input, true);
      if (selected === "product") {
        const current = this.resolve(this.singletonRef("product"), "product");
        if (
          textFields.some(
            (field) =>
              typeof current.data[field] === "string" && (current.data[field] as string).length > 0,
          )
        ) {
          throw new RelayError(
            "ALREADY_EXISTS",
            "Паспорт уже заполнен; используйте update с его ревизией",
            4,
          );
        }
        return decodeKnowledge(
          this.entities.update(current.id, "product", data, {
            actor,
            ifRevision: current.revision,
          }),
          "product",
        );
      }
      if (selected === "application") {
        this.checkBoardAddress(data.slug as string, data.prefix as string);
        const application = this.entities.create(
          "application",
          "APP",
          { ...data, implementationIds: [] },
          actor,
        );
        const board = this.entities.create(
          "board",
          "BOARD",
          {
            name: data.name,
            slug: data.slug,
            prefix: data.prefix,
            description: "",
            applicationId: application.id,
          },
          actor,
          `BOARD-${data.prefix as string}`,
        );
        return decodeKnowledge(
          this.entities.update(
            application.id,
            "application",
            { boardId: board.id },
            { actor, ifRevision: application.revision },
          ),
          "application",
        );
      }
      if (selected === "implementation") {
        const application = this.resolve(data.applicationId as string, "application");
        const target = this.resolve(data.targetId as string);
        if (
          this.implementations(application.id).some((entity) => entity.data.targetId === target.id)
        ) {
          throw new RelayError(
            "ALREADY_EXISTS",
            "Участие в этой цели уже существует; снятое участие возвращается через replaceParticipation",
            4,
          );
        }
        this.requireFeatureImplementation(application.id, target);
        const implementation = this.insertImplementation(application, target, data, actor);
        this.saveParticipation(
          application,
          this.implementations(application.id)
            .filter((entity) => entity.data.active === true)
            .map((entity) => entity.id),
          actor,
        );
        return implementation;
      }
      const prefixes = { feature: "FEATURE", scenario: "SCENARIO", document: "DOC" } as const;
      return this.projectDocument(this.entities.create(selected, prefixes[selected], data, actor));
    });
  }

  /**
   * Изменяет только переданные поля. ifRevision относится к указанной записи и проверяется
   * до no-op (REVISION_CONFLICT). Переименование приложения атомарно меняет имя его доски,
   * используя собственную ревизию доски. Неизменные данные не меняют автора/ревизию/поколение.
   */
  update<K extends EntityKind>(
    entityKind: K,
    ref: string | undefined,
    input: Fields,
    write: WriteOptions,
  ): KnowledgeRecord<Extract<K, KnowledgeKind>>;
  update(
    entityKind: EntityKind,
    ref: string | undefined,
    input: Fields,
    write: WriteOptions,
  ): KnowledgeRecord {
    const selected = kind(entityKind);
    return this.db.transaction(() => {
      options(write);
      if (selected === "board") invalid("Имя доски приложения меняется через application update");
      const current = this.resolve(ref ?? this.singletonRef(selected), selected);
      revision(current, write.ifRevision);
      const patch = this.prepare(selected, input, false, current);
      if (!Object.keys(patch).length) invalid("Укажите хотя бы одно изменяемое поле");
      const board =
        current.kind === "application" && Object.hasOwn(patch, "name")
          ? this.resolve(text(current.data.boardId, "boardId", true), "board")
          : undefined;
      if (board && board.data.applicationId !== current.id)
        throw new RelayError("INVALID_STATE", "Доска не принадлежит приложению", 4);
      const updated = this.entities.update(current.id, selected, patch, write);
      if (board) {
        // Имя доски принадлежит приложению. Читаем её собственную ревизию под
        // тем же замком писателя, сохраняя независимые изменения ключа доски.
        this.entities.update(
          board.id,
          "board",
          { name: patch.name },
          {
            actor: write.actor,
            ifRevision: board.revision,
          },
        );
      }
      return this.projectDocument(updated);
    });
  }

  /** CAS указанной записи, включая no-op; новый ключ сохраняет прежний алиас, чужой адрес даёт CONFLICT. */
  rename<K extends EntityKind>(
    entityKind: K,
    ref: string,
    key: string,
    write: WriteOptions,
  ): KnowledgeRecord<Extract<K, KnowledgeKind>>;
  rename(entityKind: EntityKind, ref: string, key: string, write: WriteOptions): KnowledgeRecord {
    const selected = kind(entityKind);
    return this.db.transaction(() => {
      options(write);
      const current = this.resolve(ref, selected);
      revision(current, write.ifRevision);
      text(key, "key", true);
      return this.projectDocument(this.entities.rename(current.id, selected, key, write));
    });
  }

  /** Список разделов и ревизия проекта-владельца из одного снимка; отсутствие у seed означает пустой список. */
  documentSections(): DocumentSections {
    return this.db.snapshot(() => {
      const project = this.resolve(this.singletonRef("project"), "project");
      return { project: project.key, revision: project.revision, items: this.sections(project) };
    });
  }

  /** Проверенные отношения и ревизия документа из одного снимка, без загрузки содержания целей. */
  documentLinks(ref: string): DocumentLinks {
    return this.db.snapshot(() => {
      const document = this.resolve(ref, "document");
      return { ref: document.key, revision: document.revision, items: document.data.relations };
    });
  }

  /**
   * ifRevision принадлежит проекту, не документу. Удаление резервирует ID раздела навсегда,
   * но не переписывает документы: их эффективный раздел вычисляется при чтении. Проверка,
   * резервирование и запись атомарны; CAS проверяется до no-op, повреждение вызывает CORRUPT_DATA.
   */
  changeSection(
    action: "create" | "update" | "move" | "remove",
    input: Fields,
    write: WriteOptions,
  ): KnowledgeRecord<"project"> {
    return this.db.transaction(() => {
      enumeration(action, ["create", "update", "move", "remove"], "action");
      options(write);
      const project = this.resolve(this.singletonRef("project"), "project");
      revision(project, write.ifRevision);
      fields(
        input,
        action === "create" || action === "update"
          ? ["id", "name"]
          : action === "move"
            ? ["id", "before", "last"]
            : ["id"],
      );
      const id =
        action === "create" && !Object.hasOwn(input, "id")
          ? crypto.randomUUID()
          : text(input.id, "id", true);
      if (id.length > 64 || !/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/u.test(id))
        invalid("id раздела: до 64 латинских букв, цифр, дефисов и подчёркиваний");
      const sections = this.sections(project).map((section) => ({ ...section }));
      const retired = [...(project.data.retiredDocumentSectionIds ?? [])];
      const index = sections.findIndex((section) => section.id === id);
      if (action === "create") {
        if (index !== -1 || retired.includes(id))
          throw new RelayError("ALREADY_EXISTS", `ID раздела ${id} уже использован`, 4);
        if (sections.length >= 100) invalid("Допускается не более 100 разделов");
        sections.push({ id, name: name(input.name) });
      } else {
        if (index === -1) throw new RelayError("NOT_FOUND", `Раздел ${id} не найден`, 3);
        const section = sections[index]!;
        if (action === "update") section.name = name(input.name);
        if (action === "remove") {
          sections.splice(index, 1);
          retired.push(id);
        }
        if (action === "move") {
          if (Object.hasOwn(input, "last")) boolean(input.last, "last");
          if (Object.hasOwn(input, "before") === (input.last === true))
            invalid("Укажите before (null — в конец) либо last: true");
          const before =
            input.last === true || input.before === null
              ? null
              : text(input.before, "before", true);
          if (before === id) invalid("Нельзя переместить раздел перед самим собой");
          if (before !== null && !sections.some((item) => item.id === before))
            throw new RelayError("NOT_FOUND", `Раздел ${before} не найден`, 3);
          sections.splice(index, 1);
          sections.splice(
            before === null ? sections.length : sections.findIndex((item) => item.id === before),
            0,
            section,
          );
        }
      }
      if (same(sections, this.sections(project))) return project;
      // Документы хранят прежний ID: эффективный раздел вычисляется при чтении,
      // поэтому удаление раздела не подменяет автора и ревизию документов.
      return decodeKnowledge(
        this.entities.update(
          project.id,
          "project",
          { documentSections: sections, retiredDocumentSectionIds: retired },
          write,
        ),
        "project",
      );
    });
  }

  /**
   * Меняет пару цель+тип под CAS документа. Разрешение цели, проверки и запись атомарны;
   * повтор той же связи/удаление отсутствующей — no-op только при актуальной ревизии.
   * Новая связь со снятой реализацией запрещена, прежнюю можно изменить или снять.
   */
  linkDocument(
    ref: string,
    target: string,
    write: WriteOptions & { remove?: boolean; type?: string; description?: string },
  ): KnowledgeRecord<"document"> {
    return this.db.transaction(() => {
      options(write, ["remove", "type", "description"]);
      const document = this.resolve(ref, "document");
      revision(document, write.ifRevision);
      const remove = Object.hasOwn(write, "remove") ? boolean(write.remove, "remove") : false;
      const relationType = Object.hasOwn(write, "type")
        ? enumeration(write.type, DOCUMENT_RELATION_TYPES, "type")
        : "documents";
      if (Object.hasOwn(write, "description")) text(write.description, "description");
      if (remove && Object.hasOwn(write, "description"))
        invalid("Открепление не принимает description");
      const entity = this.resolve(target);
      const relations = this.relations(document);
      const existing = relations.find(
        (relation) => relation.target.id === entity.id && relation.type === relationType,
      );
      this.checkRelationTarget(entity, document.id, remove || existing !== undefined);
      if (remove && !existing) return this.projectDocument(document);
      const next = remove
        ? relations.filter((relation) => relation !== existing)
        : existing
          ? relations.map((relation) =>
              relation === existing
                ? { ...relation, description: write.description ?? relation.description }
                : relation,
            )
          : [
              ...relations,
              {
                target: { kind: entity.kind, id: entity.id },
                type: relationType,
                description: write.description ?? "",
              },
            ];
      if (next.length > 100) invalid("Допускается не более 100 отношений документа");
      if (same(next, relations)) return this.projectDocument(document);
      return this.projectDocument(
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
   * Полностью заменяет участие под CAS приложения (не отдельных реализаций), включая no-op.
   * Проверки FI/SI и изменения реализаций/состава атомарны. Снятие сохраняет ID, ключ и тексты;
   * повторное включение восстанавливает существующую реализацию. Любой отказ откатывает весь состав.
   */
  replaceParticipation(
    application: string,
    targets: string[],
    write: WriteOptions,
  ): KnowledgeRecord<"application"> {
    return this.db.transaction(() => {
      options(write);
      const app = this.resolve(application, "application");
      revision(app, write.ifRevision);
      if (!Array.isArray(targets)) invalid("targets: требуется массив ссылок");
      const existing = this.implementations(app.id);
      const selected = Array.from(targets, (ref) => {
        const entity = this.resolve(text(ref, "targets", true));
        if (entity.kind === "implementation") {
          if (entity.data.applicationId !== app.id)
            invalid("Реализация принадлежит другому приложению");
          return this.resolve(entity.data.targetId as string);
        }
        if (entity.kind !== "feature" && entity.kind !== "scenario")
          invalid("Состав принимает фичи, сценарии или реализации этого приложения");
        return entity;
      });
      const selectedIds = new Set(selected.map((entity) => entity.id));
      if (selectedIds.size !== selected.length) invalid("В составе повторяется одна и та же цель");
      for (const target of selected) {
        if (target.kind === "scenario" && !selectedIds.has(target.data.featureId as string))
          invalid("SI требует FI своей фичи в выбранном составе");
      }
      // Выбор полностью проверен под той же транзакцией, что и запись. Снятые
      // реализации не удаляются: их повторное включение сохраняет ID, ключ и текст.
      const active: string[] = [];
      for (const target of selected) {
        const implementation = existing.find((entity) => entity.data.targetId === target.id);
        if (implementation) {
          if (implementation.data.active !== true)
            this.entities.update(
              implementation.id,
              "implementation",
              { active: true },
              { actor: write.actor, ifRevision: implementation.revision },
            );
          active.push(implementation.id);
        } else {
          active.push(
            this.insertImplementation(
              app,
              target,
              { title: target.data.name, description: "", status: "none" },
              write.actor,
            ).id,
          );
        }
      }
      for (const implementation of existing) {
        if (
          implementation.data.active === true &&
          !selectedIds.has(implementation.data.targetId as string)
        ) {
          this.entities.update(
            implementation.id,
            "implementation",
            { active: false },
            { actor: write.actor, ifRevision: implementation.revision },
          );
        }
      }
      return this.saveParticipation(app, active, write.actor);
    });
  }

  private singletonRef(selected: KnowledgeKind): string {
    if (selected === "project") return this.db.projectId;
    if (selected === "product") return "PRODUCT";
    return invalid(`Для ${selected} требуется ref`);
  }

  private resolve<K extends KnowledgeKind>(ref: string, expectedKind: K): KnowledgeRecord<K>;
  private resolve(ref: string, expectedKind?: EntityKind): EntityRecord;
  private resolve(ref: string, expectedKind?: EntityKind): EntityRecord {
    const record = this.entities.get(text(ref, "ref", true), expectedKind);
    return isKnowledgeKind(record.kind) ? decodeKnowledge(record, record.kind) : record;
  }

  private sections(project = this.resolve(this.singletonRef("project"), "project")): Section[] {
    return project.data.documentSections ?? [];
  }

  private sectionIndex(): DocumentSectionIndex {
    return indexDocumentSections(this.resolve(this.singletonRef("project"), "project"));
  }

  private projectDocument<K extends KnowledgeKind>(
    entity: KnowledgeRecord<K>,
    sections?: DocumentSectionIndex,
  ): KnowledgeRecord<K>;
  private projectDocument(entity: EntityRecord, sections?: DocumentSectionIndex): KnowledgeRecord;
  private projectDocument(entity: EntityRecord, sections?: DocumentSectionIndex): KnowledgeRecord {
    const checked = decodeKnowledge(entity, kind(entity.kind));
    if (checked.kind !== "document") return checked;
    return projectDocumentSection(checked, sections ?? this.sectionIndex());
  }

  private relations(document?: EntityRecord): Relation[] {
    return document === undefined ? [] : decodeKnowledge(document, "document").data.relations;
  }

  private prepare(
    selected: KnowledgeKind,
    input: Fields,
    creating: boolean,
    current?: EntityRecord,
  ): Fields {
    fields(input, [...writable[selected], ...(creating ? (createOnly[selected] ?? []) : [])]);
    const data: Fields = {};
    for (const field of ["name", "title", "summary", "description", "body"]) {
      if (Object.hasOwn(input, field))
        data[field] =
          field === "name" || field === "title"
            ? selected === "project"
              ? projectName(input[field])
              : name(input[field], field)
            : text(input[field], field, field === "body");
    }
    if (creating) {
      const titleField = selected === "implementation" ? "title" : "name";
      data[titleField] = name(input[titleField], titleField);
      if (selected === "document") data.body = text(input.body, "body", true);
      else data.description ??= "";
      if (writable[selected].includes("summary")) data.summary ??= "";
    }
    if (Object.hasOwn(input, "slug")) data.slug = slug(input.slug);
    if (selected === "application") {
      if (creating) {
        data.slug = slug(input.slug);
        data.prefix = prefix(
          Object.hasOwn(input, "prefix") ? input.prefix : (data.slug as string).toUpperCase(),
        );
      }
      if (creating || Object.hasOwn(input, "type"))
        data.type = enumeration(
          Object.hasOwn(input, "type") ? input.type : "frontend",
          APPLICATION_TYPES,
          "type",
        );
    }
    if (selected === "scenario" && creating)
      data.featureId = this.resolve(
        text(alias(input, "feature", "featureId"), "feature", true),
        "feature",
      ).id;
    if (selected === "implementation") {
      if (Object.hasOwn(input, "status") || creating)
        data.status = enumeration(
          Object.hasOwn(input, "status") ? input.status : "none",
          IMPLEMENTATION_STATUSES,
          "status",
        );
      if (creating) {
        data.applicationId = this.resolve(
          text(alias(input, "application", "applicationId"), "application", true),
          "application",
        ).id;
        const target = this.resolve(text(input.target, "target", true));
        if (target.kind !== "feature" && target.kind !== "scenario")
          invalid("target: требуется фича или сценарий");
        Object.assign(data, this.implementationTarget(target));
      }
    }
    if (selected === "document") {
      if (creating || Object.hasOwn(input, "documentKind"))
        data.documentKind = enumeration(
          Object.hasOwn(input, "documentKind") ? input.documentKind : "description",
          documentKinds,
          "documentKind",
        );
      if (creating || Object.hasOwn(input, "documentStatus"))
        data.documentStatus = enumeration(
          Object.hasOwn(input, "documentStatus") ? input.documentStatus : "draft",
          documentStatuses,
          "documentStatus",
        );
      if (creating || Object.hasOwn(input, "pinned"))
        data.pinned = Object.hasOwn(input, "pinned") ? boolean(input.pinned, "pinned") : false;
      if (creating || Object.hasOwn(input, "sectionId")) {
        const id = Object.hasOwn(input, "sectionId") ? input.sectionId : null;
        if (id !== null) {
          text(id, "sectionId", true);
          if (!this.sections().some((section) => section.id === id))
            throw new RelayError("NOT_FOUND", `Раздел ${id} не найден`, 3);
        }
        data.sectionId = id;
      }
      if (Object.hasOwn(input, "relations") && Object.hasOwn(input, "targets"))
        invalid("Укажите relations либо targets");
      if (creating || Object.hasOwn(input, "relations") || Object.hasOwn(input, "targets")) {
        const raw = Object.hasOwn(input, "relations")
          ? input.relations
          : Object.hasOwn(input, "targets")
            ? input.targets
            : [];
        if (!Array.isArray(raw)) invalid("relations/targets: требуется массив");
        data.relations = this.normalizeRelations(
          Object.hasOwn(input, "targets")
            ? Array.from(raw, (ref) => ({ target: text(ref, "targets", true), type: "documents" }))
            : raw,
          current,
        );
      }
    }
    return data;
  }

  private normalizeRelations(input: unknown[], current?: EntityRecord): Relation[] {
    if (input.length > 100) invalid("Допускается не более 100 отношений документа");
    const seen = new Set<string>();
    return Array.from(input, (value) => {
      const item = fields(value, ["target", "type", "description"], "Отношение");
      const relationType = Object.hasOwn(item, "type")
        ? enumeration(item.type, DOCUMENT_RELATION_TYPES, "type")
        : "documents";
      let target: EntityRecord;
      if (typeof item.target === "string") target = this.resolve(item.target);
      else {
        const reference = fields(item.target, ["kind", "id"], "Цель отношения");
        target = this.resolve(
          text(reference.id, "target.id", true),
          enumeration(reference.kind, relationKinds, "target.kind") as EntityKind,
        );
      }
      const previous = this.relations(current).some(
        (relation) => relation.target.id === target.id && relation.type === relationType,
      );
      this.checkRelationTarget(target, current?.id, previous);
      const pair = `${target.id}:${relationType}`;
      if (seen.has(pair)) invalid("Повторяется пара цель + тип отношения");
      seen.add(pair);
      return {
        target: { kind: target.kind, id: target.id },
        type: relationType,
        description: Object.hasOwn(item, "description")
          ? text(item.description, "description")
          : "",
      };
    });
  }

  private checkRelationTarget(
    target: EntityRecord,
    documentId: string | undefined,
    existing: boolean,
  ): asserts target is EntityRecord & { kind: Relation["target"]["kind"] } {
    if (!(relationKinds as readonly string[]).includes(target.kind))
      invalid("Этот вид сущности не поддерживает прикрепление документа");
    if (target.id === documentId) invalid("Документ не может ссылаться на себя");
    if (!existing && target.kind === "implementation" && target.data.active !== true)
      invalid("Новое прикрепление к снятой реализации недопустимо");
  }

  private checkBoardAddress(boardSlug: string, boardPrefix: string): void {
    if (
      this.entities
        .list("board")
        .map((entity) => decodeKnowledge(entity, "board"))
        .some((entity) => entity.data.slug === boardSlug || entity.data.prefix === boardPrefix) ||
      this.entities
        .list("application")
        .map((entity) => decodeKnowledge(entity, "application"))
        .some((entity) => entity.data.slug === boardSlug || entity.data.prefix === boardPrefix)
    ) {
      throw new RelayError("ALREADY_EXISTS", "Slug или префикс доски уже занят", 4);
    }
  }

  private implementations(applicationId: string): KnowledgeRecord<"implementation">[] {
    return this.entities
      .list("implementation")
      .map((entity) => decodeKnowledge(entity, "implementation"))
      .filter((entity) => entity.data.applicationId === applicationId);
  }

  private implementationTarget(target: EntityRecord): Fields {
    return {
      targetId: target.id,
      targetKind: target.kind,
      featureId: target.kind === "feature" ? target.id : target.data.featureId,
      ...(target.kind === "scenario" ? { scenarioId: target.id } : {}),
    };
  }

  private requireFeatureImplementation(applicationId: string, target: EntityRecord): void {
    if (
      target.kind === "scenario" &&
      !this.implementations(applicationId).some(
        (entity) => entity.data.targetId === target.data.featureId && entity.data.active === true,
      )
    )
      invalid("SI требует активную FI той же фичи в том же приложении");
  }

  private insertImplementation(
    app: EntityRecord,
    target: EntityRecord,
    data: Fields,
    actor: string,
  ): KnowledgeRecord<"implementation"> {
    return decodeKnowledge(
      this.entities.create(
        "implementation",
        `${app.data.prefix as string}-${target.kind === "feature" ? "FI" : "SI"}`,
        {
          ...data,
          ...this.implementationTarget(target),
          applicationId: app.id,
          active: true,
        },
        actor,
      ),
      "implementation",
    );
  }

  private saveParticipation(
    app: KnowledgeRecord<"application">,
    ids: string[],
    actor: string,
  ): KnowledgeRecord<"application"> {
    const ordered = [...ids].sort();
    if (same(ordered, app.data.implementationIds)) return app;
    return decodeKnowledge(
      this.entities.update(
        app.id,
        "application",
        { implementationIds: ordered },
        { actor, ifRevision: app.revision },
      ),
      "application",
    );
  }
}
