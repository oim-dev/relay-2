import { DOCUMENT_TARGET_KINDS, KNOWLEDGE_KINDS, type KnowledgeKind } from "@relay/contracts";
import { KNOWLEDGE_WRITABLE_FIELDS } from "../knowledge/knowledge-constants";
import { batchAction } from "./batch-action";
import { batchIdentity, type BatchStepContext } from "./batch-context";
import { batchMessages } from "./batch.messages";
import type {
  BatchAction,
  BatchActionOptions,
  BatchAddressField,
  BatchOutcome,
} from "./batch.types";

const creationExtraFields = {
  scenario: ["feature", "featureId"],
  application: ["slug", "prefix"],
  implementation: ["application", "applicationId", "target"],
} as const;
const sectionInputFields = {
  create: ["id", "name"],
  update: ["id", "name"],
  move: ["id", "before", "last"],
  remove: ["id"],
} as const;

const documentAddresses: readonly BatchAddressField[] = [
  { path: "sectionId", kinds: ["document-section"] },
  { path: "targets.*", kinds: DOCUMENT_TARGET_KINDS },
  { path: "relations.*.target", kinds: DOCUMENT_TARGET_KINDS },
  { path: "relations.*.target.id", kinds: DOCUMENT_TARGET_KINDS },
];

/**
 * Возвращает адресные поля создания; значения вне этого списка не заменяются.
 */
function creationAddresses(kind: KnowledgeKind): readonly BatchAddressField[] {
  switch (kind) {
    case "scenario":
      return [
        { path: "feature", kinds: ["feature"] },
        { path: "featureId", kinds: ["feature"] },
      ];
    case "implementation":
      return [
        { path: "application", kinds: ["application"] },
        { path: "applicationId", kinds: ["application"] },
        { path: "target", kinds: ["feature", "scenario"] },
      ];
    case "document":
      return documentAddresses;
    default:
      return [];
  }
}

/**
 * Объявляет исключения создания: паспорт уже существует, а новая реализация меняет состав приложения.
 */
function creationOptions(kind: KnowledgeKind): BatchActionOptions {
  const addresses = creationAddresses(kind);
  if (kind === "implementation") {
    return {
      description: batchMessages.descriptions.implementation,
      revisionOwner: "application",
      addresses,
    };
  }
  if (kind === "product") {
    return { description: batchMessages.descriptions.product, revisionOwner: "product", addresses };
  }
  return { description: batchMessages.descriptions.knowledge, addresses };
}

/**
 * Создаёт знания через владельца; зависимые приложение/доска явно входят в итоговую выдачу.
 * Первое заполнение продукта и создание FI/SI требуют явный CAS существующего владельца.
 */
function createKnowledge(context: BatchStepContext, kind: KnowledgeKind): BatchOutcome {
  if (kind === "product") {
    context.write(context.knowledge.get("product"));
  }
  if (kind === "implementation") {
    const applicationRef =
      context.input.application === undefined
        ? context.text("applicationId")
        : context.text("application");
    context.write(context.knowledge.get("application", applicationRef));
  }
  const created = context.knowledge.create(kind, context.input, context.actor);
  context.created(created);
  if (created.kind === "application") {
    const board = context.knowledge.get("board", created.data.boardId);
    context.created(board);
    context.touch(board);
    return context.result(created, created, [{ name: "board", ...batchIdentity(board) }]);
  }
  if (created.kind === "implementation") {
    const application = context.knowledge.get("application", created.data.applicationId);
    return context.result(created, application);
  }
  return context.result(created);
}

/**
 * Изменяет содержание знаний под CAS и явно учитывает синхронизированную доску приложения.
 */
function updateKnowledge(context: BatchStepContext, kind: KnowledgeKind): BatchOutcome {
  const ref = kind === "project" || kind === "product" ? undefined : context.ref(kind);
  const current = context.knowledge.get(kind, ref);
  const updated = context.knowledge.update(kind, ref, context.input, context.write(current));
  if (updated.kind === "application" && context.input.name !== undefined) {
    const board = context.knowledge.get("board", updated.data.boardId);
    context.touch(board);
    return context.result(updated, updated, [{ name: "board", ...batchIdentity(board) }]);
  }
  return context.result(updated);
}

/**
 * Заменяет участие через сервис, сравнивая адресные проекции ID/ревизий выбранного приложения.
 * Полную историю для предметной проверки читает только KnowledgeService; адаптер не получает её тексты.
 * Изменённые ID декодируются владельцами в общей итоговой выборке пакета; no-op их туда не добавляет.
 */
function replaceParticipation(context: BatchStepContext): BatchOutcome {
  const ref = context.ref("application");
  const current = context.knowledge.get("application", ref);
  const write = context.write(current);
  const before = new Map(
    context.db
      .listIdentitiesByField("implementation", "applicationId", current.id)
      .map((record) => [record.id, record.revision]),
  );
  const updated = context.knowledge.replaceParticipation(ref, context.strings("targets"), write);
  const changed = context.db
    .listIdentitiesByField("implementation", "applicationId", current.id)
    .filter((record) => record.revision !== before.get(record.id));
  for (const record of changed) {
    if (!before.has(record.id)) {
      context.created(record);
    }
  }
  context.touch(...changed);
  return context.result(
    updated,
    updated,
    changed.map((record) => ({ name: "implementation", ...batchIdentity(record) })),
  );
}

/**
 * Собирает полный каталог локальных предметных действий знаний, без конфигурации и жизненного цикла БД.
 */
export function knowledgeBatchActions(): BatchAction<BatchStepContext>[] {
  const actions: BatchAction<BatchStepContext>[] = [];
  for (const kind of KNOWLEDGE_KINDS) {
    const singleton = kind === "project" || kind === "product";
    if (kind !== "project" && kind !== "board") {
      const extra =
        kind === "scenario" || kind === "application" || kind === "implementation"
          ? creationExtraFields[kind]
          : [];
      actions.push(
        batchAction(
          `${kind}.create`,
          [...KNOWLEDGE_WRITABLE_FIELDS[kind], ...extra],
          creationOptions(kind),
          (context) => createKnowledge(context, kind),
        ),
      );
    }
    if (kind !== "board") {
      actions.push(
        batchAction(
          `${kind}.update`,
          KNOWLEDGE_WRITABLE_FIELDS[kind],
          {
            description: batchMessages.descriptions.knowledge,
            ref: !singleton,
            revisionOwner: kind,
            addresses: kind === "document" ? documentAddresses : [],
          },
          (context) => updateKnowledge(context, kind),
        ),
      );
    }
    actions.push(
      batchAction(
        `${kind}.rename`,
        ["key"],
        {
          description: batchMessages.descriptions.knowledge,
          ref: !singleton,
          revisionOwner: kind,
        },
        (context) => {
          const ref = singleton ? undefined : context.ref(kind);
          const current = context.knowledge.get(kind, ref);
          return context.result(
            context.knowledge.rename(kind, ref, context.text("key"), context.write(current)),
          );
        },
      ),
    );
  }
  actions.push(
    batchAction(
      "application.participation.replace",
      ["targets"],
      {
        description: batchMessages.descriptions.participation,
        ref: true,
        revisionOwner: "application",
        addresses: [{ path: "targets.*", kinds: ["feature", "scenario", "implementation"] }],
      },
      replaceParticipation,
    ),
  );
  for (const action of ["create", "update", "move", "remove"] as const) {
    actions.push(
      batchAction(
        `document.section.${action}`,
        sectionInputFields[action],
        {
          description: batchMessages.descriptions.section,
          revisionOwner: "project",
          addresses:
            action === "create"
              ? []
              : [
                  { path: "id", kinds: ["document-section"] },
                  { path: "before", kinds: ["document-section"] },
                ],
        },
        (context) => {
          const current = context.knowledge.get("project");
          const previous = new Set(
            (current.data.documentSections ?? []).map((section) => section.id),
          );
          const updated = context.knowledge.changeSection(
            action,
            context.input,
            context.write(current),
          );
          const id =
            action === "create"
              ? updated.data.documentSections?.find((section) => !previous.has(section.id))?.id
              : context.text("id");
          return context.nested(id, "document-section", updated);
        },
      ),
    );
  }
  for (const remove of [false, true]) {
    actions.push(
      batchAction(
        `document.${remove ? "unlink" : "link"}`,
        remove ? ["target", "type"] : ["target", "type", "description"],
        {
          description: batchMessages.descriptions.knowledge,
          ref: true,
          revisionOwner: "document",
          addresses: [{ path: "target", kinds: DOCUMENT_TARGET_KINDS }],
        },
        (context) => {
          const ref = context.ref("document");
          const write = context.write(context.knowledge.get("document", ref));
          return context.result(
            context.knowledge.linkDocument(ref, context.text("target"), {
              ...write,
              remove,
              ...(context.input.type === undefined ? {} : { type: context.text("type") }),
              ...(context.input.description === undefined
                ? {}
                : { description: context.string("description") }),
            }),
          );
        },
      ),
    );
  }
  return actions;
}
