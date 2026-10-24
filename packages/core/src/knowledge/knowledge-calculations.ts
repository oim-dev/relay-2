import type { FeatureData, KnowledgeKind, KnowledgeRecord, WriteOptions } from "@relay/contracts";
import { changeCommandEntity, createCommandEntity } from "../commands/command-entity";
import { knowledgeCommandEffect } from "./knowledge-transition";
import {
  changeDocumentSections,
  requireActiveDocumentSection,
  validateDocumentSection,
} from "./document-sections";
import type { DocumentSectionChange, DocumentSectionIndex } from "./document-sections.types";
import { requireKnowledgeAddresses } from "./knowledge-command-addresses";
import type {
  KnowledgeAddressObservation,
  KnowledgeAllocation,
  KnowledgeDelta,
} from "./knowledge-command.types";
import { decodeKnowledge } from "./knowledge-data";
import { changeKnowledgeRelation, resolvePreparedKnowledgeRelations } from "./knowledge-relations";
import {
  requireEmptyProduct,
  requireKnowledgeRevision,
  sameKnowledgeCollection,
} from "./knowledge-rules";
import type {
  KnowledgeCreation,
  KnowledgeLinkChange,
  KnowledgeReference,
  KnowledgeUpdate,
  PreparedKnowledgeRelation,
} from "./knowledge.types";

/**
 * Рассчитывает новую фичу по проверенным данным и защищённым адресам.
 */
export function calculateFeatureCreation(
  data: Readonly<FeatureData>,
  allocation: KnowledgeAllocation,
): KnowledgeDelta<"feature"> {
  requireKnowledgeAddresses("feature", allocation.id, allocation.addresses);
  const record = decodeKnowledge(
    createCommandEntity("feature", allocation.key, { ...data }, allocation),
    "feature",
  );
  return { record, effects: knowledgeCommandEffect(null, record, "feature.create") };
}

/**
 * Рассчитывает сценарий с постоянным ID загруженной фичи.
 */
export function calculateScenarioCreation(
  data: Readonly<FeatureData>,
  feature: KnowledgeRecord<"feature">,
  allocation: KnowledgeAllocation,
): KnowledgeDelta<"scenario"> {
  requireKnowledgeAddresses("scenario", allocation.id, allocation.addresses);
  const record = decodeKnowledge(
    createCommandEntity(
      "scenario",
      allocation.key,
      {
        ...data,
        featureId: feature.id,
      },
      allocation,
    ),
    "scenario",
  );
  return { record, effects: knowledgeCommandEffect(null, record, "scenario.create") };
}

/**
 * Условно заполняет пустой паспорт под исходным CAS; повтор не создаёт второй singleton.
 */
export function calculateProductCreation(
  current: KnowledgeRecord<"product">,
  data: Readonly<FeatureData>,
  write: WriteOptions,
  timestamp: string,
): KnowledgeDelta<"product"> {
  requireKnowledgeRevision(current, write.ifRevision);
  requireEmptyProduct(current);
  const record = decodeKnowledge(
    changeCommandEntity(current, { ...data }, write, timestamp),
    "product",
  );
  return { record, effects: knowledgeCommandEffect(current, record, "product.create") };
}

/**
 * Рассчитывает документ по готовым разделам и целям; хранит raw sectionId.
 */
export function calculateDocumentCreation(
  command: Extract<KnowledgeCreation, { kind: "document" }>,
  sections: DocumentSectionIndex,
  targets: readonly PreparedKnowledgeRelation[],
  allocation: KnowledgeAllocation,
): KnowledgeDelta<"document"> {
  requireActiveDocumentSection(command.data.sectionId, sections);
  requireKnowledgeAddresses("document", allocation.id, allocation.addresses);
  const relations = resolvePreparedKnowledgeRelations(targets);
  const record = decodeKnowledge(
    createCommandEntity(
      "document",
      allocation.key,
      {
        ...command.data,
        relations,
      },
      allocation,
    ),
    "document",
  );
  return { record, effects: knowledgeCommandEffect(null, record, "document.create") };
}

/**
 * Меняет обычное содержание под клиентским CAS; зависимая доска рассчитывается отдельно до apply.
 */
export function calculateKnowledgeUpdate(
  current: KnowledgeRecord,
  command: Exclude<KnowledgeUpdate, { kind: "document" }>,
  write: WriteOptions,
  timestamp: string,
): KnowledgeDelta {
  const checked = decodeKnowledge(current, command.kind);
  const record = decodeKnowledge(
    changeCommandEntity(checked, { ...command.data }, write, timestamp),
    command.kind,
  );
  return { record, effects: knowledgeCommandEffect(current, record, `${command.kind}.update`) };
}

/**
 * Меняет документ без потери исторической ссылки на снятый раздел.
 * Только явно заданный раздел требует активности; прежние снятые отношения разрешены.
 */
export function calculateDocumentUpdate(
  current: KnowledgeRecord<"document">,
  command: Extract<KnowledgeUpdate, { kind: "document" }>,
  sections: DocumentSectionIndex,
  targets: readonly PreparedKnowledgeRelation[] | undefined,
  write: WriteOptions,
  timestamp: string,
): KnowledgeDelta<"document"> {
  requireKnowledgeRevision(current, write.ifRevision);
  if (command.data.sectionId !== undefined) {
    requireActiveDocumentSection(command.data.sectionId, sections);
  }
  const relations =
    targets === undefined ? undefined : resolvePreparedKnowledgeRelations(targets, current);
  const record = decodeKnowledge(
    changeCommandEntity(
      current,
      {
        ...command.data,
        ...(relations === undefined ? {} : { relations }),
      },
      write,
      timestamp,
    ),
    "document",
  );
  validateDocumentSection(record, sections);
  return { record, effects: knowledgeCommandEffect(current, record, "document.update") };
}

/**
 * Переименовывает под исходной ревизией; прежний ключ сохраняется общим commit как алиас.
 */
export function calculateKnowledgeRename<K extends KnowledgeKind>(
  current: KnowledgeRecord<K>,
  key: string,
  addresses: readonly KnowledgeAddressObservation[],
  write: WriteOptions,
  timestamp: string,
): KnowledgeDelta<K> {
  requireKnowledgeRevision(current, write.ifRevision);
  if (key !== current.key) {
    requireKnowledgeAddresses(current.kind, current.id, addresses);
  }
  const record = decodeKnowledge(
    changeCommandEntity(current, {}, write, timestamp, key),
    current.kind,
  );
  return { record, effects: knowledgeCommandEffect(current, record, `${current.kind}.rename`) };
}

/**
 * Меняет разделы под CAS проекта без чтения или переписывания документов.
 * Снятие сохраняет вечный резерв ID, равный порядок не дополняет старый seed пустыми полями.
 */
export function calculateDocumentSections(
  current: KnowledgeRecord<"project">,
  change: DocumentSectionChange,
  write: WriteOptions,
  timestamp: string,
): KnowledgeDelta<"project"> {
  requireKnowledgeRevision(current, write.ifRevision);
  const next = changeDocumentSections(current, change);
  const patch = sameKnowledgeCollection(next.documentSections, current.data.documentSections ?? [])
    ? {}
    : { ...next };
  const record = decodeKnowledge(changeCommandEntity(current, patch, write, timestamp), "project");
  return {
    record,
    effects: knowledgeCommandEffect(current, record, `document.section.${change.action}`, {
      sectionId: change.id,
      ...(change.action === "move" ? { beforeSectionId: change.before } : {}),
    }),
  };
}

/**
 * Меняет одну пару отношения по уже загруженной цели; снятие и повтор сохраняют no-op семантику.
 */
export function calculateDocumentLink(
  current: KnowledgeRecord<"document">,
  target: KnowledgeReference,
  change: KnowledgeLinkChange,
  sections: DocumentSectionIndex,
  write: WriteOptions,
  timestamp: string,
): KnowledgeDelta<"document"> {
  requireKnowledgeRevision(current, write.ifRevision);
  const relations = changeKnowledgeRelation(current, target, change);
  const record = decodeKnowledge(
    changeCommandEntity(current, { relations }, write, timestamp),
    "document",
  );
  validateDocumentSection(record, sections);
  return {
    record,
    effects: knowledgeCommandEffect(
      current,
      record,
      `document.${change.remove ? "unlink" : "link"}`,
    ),
  };
}
