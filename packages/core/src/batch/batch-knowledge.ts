import {
  DOCUMENT_TARGET_KINDS,
  KNOWLEDGE_KINDS,
  RelayError,
  type KnowledgeKind,
} from "@relay/contracts";
import { KNOWLEDGE_WRITABLE_FIELDS } from "../knowledge/knowledge-constants";
import { parseDocumentSectionChange } from "../knowledge/document-section-input";
import { validateDocumentSection } from "../knowledge/document-sections";
import {
  calculateApplicationBoard,
  calculateApplicationCreation,
} from "../knowledge/knowledge-applications";
import {
  calculateDocumentCreation,
  calculateDocumentLink,
  calculateDocumentSections,
  calculateDocumentUpdate,
  calculateFeatureCreation,
  calculateKnowledgeRename,
  calculateKnowledgeUpdate,
  calculateProductCreation,
  calculateScenarioCreation,
} from "../knowledge/knowledge-calculations";
import {
  loadKnowledgeAddresses,
  loadKnowledgeAllocation,
  loadKnowledgeParticipation,
  loadKnowledgeReference,
  loadKnowledgeRelations,
  loadKnowledgeSections,
  loadParticipationSelection,
} from "../knowledge/knowledge-command-loaders";
import type { KnowledgeDelta } from "../knowledge/knowledge-command.types";
import { decodeKnowledge } from "../knowledge/knowledge-data";
import {
  parseKnowledgeCreation,
  parseKnowledgeLink,
  parseKnowledgeUpdate,
  parseParticipationTargets,
} from "../knowledge/knowledge-input";
import {
  calculateImplementationCreation,
  calculateParticipationReplacement,
} from "../knowledge/knowledge-participation";
import { invalidKnowledge, knowledgeText } from "../knowledge/knowledge-validation";
import { knowledgeMessages } from "../knowledge/knowledge.messages";
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
 * Сохраняет явный адрес legacy singleton; без ref выбирает постоянного проектного владельца.
 */
async function knowledgeWriteRef(context: BatchStepContext, kind: KnowledgeKind): Promise<string> {
  if (context.step.ref !== undefined) {
    return context.ref(kind);
  }
  if (kind === "project") {
    return context.commands.projectId;
  }
  if (kind === "product") {
    return "PRODUCT";
  }
  return context.ref(kind);
}

/**
 * Создаёт знания через владельца; зависимые приложение/доска явно входят в итоговую выдачу.
 * Первое заполнение продукта и создание FI/SI требуют явный CAS существующего владельца.
 */
async function createKnowledge(
  context: BatchStepContext,
  kind: KnowledgeKind,
): Promise<BatchOutcome> {
  const commands = context.commands;
  const command = parseKnowledgeCreation(kind, context.input);
  let delta: KnowledgeDelta;
  switch (command.kind) {
    case "product": {
      const current = decodeKnowledge(await commands.get("PRODUCT", "product"), "product");
      delta = calculateProductCreation(
        current,
        command.data,
        context.write(current),
        commands.timestamp,
      );
      break;
    }
    case "application": {
      const virtual = [command.data.slug, command.data.prefix];
      const application = await loadKnowledgeAllocation(
        commands,
        "application",
        "APP",
        undefined,
        virtual,
      );
      const board = await loadKnowledgeAllocation(
        commands,
        "board",
        "BOARD",
        `BOARD-${command.data.prefix}`,
        virtual,
      );
      delta = calculateApplicationCreation(command.data, application, board);
      break;
    }
    case "implementation": {
      const application = decodeKnowledge(
        await commands.get(command.application, "application"),
        "application",
      );
      const write = context.write(application);
      const loaded = await loadKnowledgeParticipation(commands, application);
      const target = await loadKnowledgeReference(commands, command.target);
      const allocation = await loadKnowledgeAllocation(
        commands,
        "implementation",
        `${application.data.prefix}-${target.kind === "scenario" ? "SI" : "FI"}`,
      );
      delta = calculateImplementationCreation(loaded, target, command.data, allocation, write);
      break;
    }
    case "feature":
      delta = calculateFeatureCreation(
        command.data,
        await loadKnowledgeAllocation(commands, "feature", "FEATURE"),
      );
      break;
    case "scenario": {
      const feature = decodeKnowledge(await commands.get(command.feature, "feature"), "feature");
      delta = calculateScenarioCreation(
        command.data,
        feature,
        await loadKnowledgeAllocation(commands, "scenario", "SCENARIO"),
      );
      break;
    }
    case "document": {
      const sections = await loadKnowledgeSections(commands);
      const targets = await loadKnowledgeRelations(commands, command.relations);
      delta = calculateDocumentCreation(
        command,
        sections,
        targets,
        await loadKnowledgeAllocation(commands, "document", "DOC"),
      );
      break;
    }
  }
  commands.apply(delta.effects);
  for (const effect of delta.effects) {
    if (effect.kind === "entity" && effect.before === null) {
      context.created(effect.after);
    }
  }
  const created = delta.record;
  if (created.kind === "application") {
    const boardEffect = delta.effects.find(
      (effect) => effect.kind === "entity" && effect.after.kind === "board",
    );
    if (boardEffect?.kind !== "entity") {
      throw new RelayError("CORRUPT_DATA", batchMessages.missingOutput);
    }
    context.touch(boardEffect.after);
    return context.result(created, created, [
      { name: "board", ...batchIdentity(boardEffect.after) },
    ]);
  }
  if (created.kind === "implementation") {
    const owner = delta.effects.find(
      (effect) => effect.kind === "entity" && effect.after.id === created.data.applicationId,
    );
    if (owner?.kind !== "entity") {
      throw new RelayError("CORRUPT_DATA", batchMessages.missingOutput);
    }
    return context.result(created, owner.after);
  }
  return context.result(created);
}

/**
 * Изменяет содержание знаний под CAS и явно учитывает синхронизированную доску приложения.
 */
async function updateKnowledge(
  context: BatchStepContext,
  kind: KnowledgeKind,
): Promise<BatchOutcome> {
  if (kind === "board") {
    invalidKnowledge(knowledgeMessages.boardUpdate);
  }
  const commands = context.commands;
  const ref = await knowledgeWriteRef(context, kind);
  const current = decodeKnowledge(await commands.get(ref, kind), kind);
  const write = context.write(current);
  const command = parseKnowledgeUpdate(kind, context.input);
  if (command.kind === "document") {
    const sections = await loadKnowledgeSections(commands);
    const targets =
      command.relations === undefined
        ? undefined
        : await loadKnowledgeRelations(commands, command.relations);
    const delta = calculateDocumentUpdate(
      decodeKnowledge(current, "document"),
      command,
      sections,
      targets,
      write,
      commands.timestamp,
    );
    commands.apply(delta.effects);
    return context.result(delta.record);
  }
  const board =
    current.kind === "application" &&
    command.kind === "application" &&
    command.data.name !== undefined
      ? decodeKnowledge(await commands.get(current.data.boardId, "board"), "board")
      : undefined;
  const delta = calculateKnowledgeUpdate(current, command, write, commands.timestamp);
  if (delta.record.kind === "application" && board !== undefined) {
    const related = calculateApplicationBoard(delta.record, board, write, commands.timestamp);
    commands.apply([...delta.effects, ...related.effects]);
    context.touch(related.record);
    return context.result(delta.record, delta.record, [
      { name: "board", ...batchIdentity(related.record) },
    ]);
  }
  commands.apply(delta.effects);
  return context.result(delta.record);
}

/**
 * Загружает только историю выбранного приложения и получает изменённые реализации из pure delta.
 */
async function replaceParticipation(context: BatchStepContext): Promise<BatchOutcome> {
  const ref = await context.ref("application");
  const current = decodeKnowledge(await context.commands.get(ref, "application"), "application");
  const write = context.write(current);
  const loaded = await loadKnowledgeParticipation(context.commands, current);
  const selected = await loadParticipationSelection(
    context.commands,
    loaded,
    parseParticipationTargets(context.input.targets),
  );
  const delta = calculateParticipationReplacement(
    loaded,
    selected,
    write,
    context.commands.timestamp,
  );
  context.commands.apply(delta.effects);
  for (const effect of delta.effects) {
    if (effect.kind === "entity" && effect.before === null) {
      context.created(effect.after);
    }
  }
  context.touch(...delta.changed);
  return context.result(
    delta.record,
    delta.record,
    delta.changed.map((record) => ({ name: "implementation", ...batchIdentity(record) })),
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
        async (context) => {
          const commands = context.commands;
          const ref = await knowledgeWriteRef(context, kind);
          const current = decodeKnowledge(await commands.get(ref, kind), kind);
          const write = context.write(current);
          const key = knowledgeText(context.input.key, "key", true);
          const virtual =
            current.kind === "application" || current.kind === "board"
              ? [current.data.slug, current.data.prefix]
              : [];
          const addresses =
            key === current.key ? [] : await loadKnowledgeAddresses(commands, kind, [key], virtual);
          const sections =
            current.kind === "document" ? await loadKnowledgeSections(commands) : undefined;
          const delta = calculateKnowledgeRename(
            current,
            key,
            addresses,
            write,
            commands.timestamp,
          );
          if (delta.record.kind === "document" && sections !== undefined) {
            validateDocumentSection(delta.record, sections);
          }
          commands.apply(delta.effects);
          return context.result(delta.record);
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
        async (context) => {
          const commands = context.commands;
          const current = decodeKnowledge(
            await commands.get(commands.projectId, "project"),
            "project",
          );
          const write = context.write(current);
          const allocatedId =
            action === "create" && context.input.id === undefined
              ? commands.allocateId()
              : undefined;
          const change = parseDocumentSectionChange(action, context.input, allocatedId);
          const delta = calculateDocumentSections(current, change, write, commands.timestamp);
          commands.apply(delta.effects);
          return context.nested(change.id, "document-section", delta.record);
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
        async (context) => {
          const commands = context.commands;
          const ref = await context.ref("document");
          const current = decodeKnowledge(await commands.get(ref, "document"), "document");
          const write = context.write(current);
          const change = parseKnowledgeLink({
            ...write,
            remove,
            ...(context.input.type === undefined ? {} : { type: context.text("type") }),
            ...(context.input.description === undefined
              ? {}
              : { description: context.string("description") }),
          });
          const target = await loadKnowledgeReference(commands, context.text("target"));
          const sections = await loadKnowledgeSections(commands);
          const delta = calculateDocumentLink(
            current,
            target,
            change,
            sections,
            write,
            commands.timestamp,
          );
          commands.apply(delta.effects);
          return context.result(delta.record);
        },
      ),
    );
  }
  return actions;
}
