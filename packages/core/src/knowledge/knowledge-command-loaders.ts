import type { EntityKind, KnowledgeKind, KnowledgeRecord } from "@relay/contracts";
import type { CommandContext } from "../commands/command-context";
import { decodeKnowledge, isKnowledgeKind } from "./knowledge-data";
import { indexDocumentSections } from "./document-sections";
import type { DocumentSectionIndex } from "./document-sections.types";
import type {
  KnowledgeAddressObservation,
  KnowledgeAllocation,
  KnowledgeParticipationContext,
  KnowledgeParticipationSelection,
} from "./knowledge-command.types";
import type {
  KnowledgeReference,
  KnowledgeRelationInput,
  PreparedKnowledgeRelation,
} from "./knowledge.types";

/**
 * Загружает единственного владельца каталога разделов и строит индекс этого состояния overlay.
 */
export async function loadKnowledgeSections(
  commands: CommandContext,
): Promise<DocumentSectionIndex> {
  return indexDocumentSections(
    decodeKnowledge(await commands.get(commands.projectId, "project"), "project"),
  );
}

/**
 * Загружает только указанную ссылку; чужие виды остаются сырыми значениями их владельцев.
 */
export async function loadKnowledgeReference(
  commands: CommandContext,
  ref: string,
  kind?: EntityKind,
): Promise<KnowledgeReference> {
  const record = await commands.get(ref, kind);
  return isKnowledgeKind(record.kind)
    ? decodeKnowledge(record, record.kind)
    : { ...record, kind: record.kind };
}

/**
 * Загружает цели в порядке ввода; aliases разрешает общий контекст одного anchor.
 */
export async function loadKnowledgeRelations(
  commands: CommandContext,
  relations: readonly KnowledgeRelationInput[],
): Promise<PreparedKnowledgeRelation[]> {
  const prepared: PreparedKnowledgeRelation[] = [];
  for (const relation of relations) {
    prepared.push({
      ...relation,
      target:
        typeof relation.target === "string"
          ? await loadKnowledgeReference(commands, relation.target)
          : await loadKnowledgeReference(commands, relation.target.id, relation.target.kind),
    });
  }
  return prepared;
}

/**
 * Получает положительные и отрицательные адресные предикаты без полного каталога.
 * Для rename передаются только проверяемый ключ и неизменяемые виртуальные адреса.
 */
export async function loadKnowledgeAddresses(
  commands: CommandContext,
  kind: KnowledgeKind,
  global: readonly string[],
  virtual: readonly string[] = [],
): Promise<KnowledgeAddressObservation[]> {
  const addresses = [...new Set([...global, ...virtual])];
  const observations: KnowledgeAddressObservation[] = [];
  for (const ref of addresses) {
    observations.push({
      ref,
      direct: await commands.identity(ref),
      virtual: kind === "application" || kind === "board" ? await commands.virtual(ref, kind) : [],
      scope: global.includes(ref) ? "global" : "kind",
    });
  }
  return observations;
}

/**
 * Выделяет ID/ключ до расчёта и загружает отсутствие адресов, в том числе UUID-алиаса.
 * Явный ключ доски не расходует числовой counter.
 */
export async function loadKnowledgeAllocation(
  commands: CommandContext,
  kind: KnowledgeKind,
  prefix: string,
  key?: string,
  virtual: readonly string[] = [],
): Promise<KnowledgeAllocation> {
  const id = commands.allocateId();
  const allocatedKey = key ?? (await commands.key(kind, prefix));
  return {
    id,
    key: allocatedKey,
    actor: commands.actor,
    timestamp: commands.timestamp,
    addresses: await loadKnowledgeAddresses(commands, kind, [id, allocatedKey], virtual),
  };
}

/**
 * Загружает полную историю только своего приложения; полноту активных ID проверяет pure правило.
 */
export async function loadKnowledgeParticipation(
  commands: CommandContext,
  application: KnowledgeRecord<"application">,
): Promise<KnowledgeParticipationContext> {
  return {
    application,
    existing: (await commands.byField("implementation", "applicationId", application.id)).map(
      (record) => decodeKnowledge(record, "implementation"),
    ),
  };
}

/**
 * Загружает выбранные цели и исходные цели FI/SI; выделяет ключи лишь отсутствующим участиям.
 * Проверка принадлежности, дубликатов и обязательной FI остаётся у pure calculator.
 */
export async function loadParticipationSelection(
  commands: CommandContext,
  context: KnowledgeParticipationContext,
  refs: readonly string[],
): Promise<KnowledgeParticipationSelection[]> {
  const existing = new Set(context.existing.map((record) => record.data.targetId));
  const selected: KnowledgeParticipationSelection[] = [];
  for (const ref of refs) {
    const reference = await loadKnowledgeReference(commands, ref);
    const target =
      reference.kind === "implementation"
        ? await loadKnowledgeReference(commands, reference.data.targetId)
        : null;
    const resolved = target ?? reference;
    const allocation = existing.has(resolved.id)
      ? null
      : await loadKnowledgeAllocation(
          commands,
          "implementation",
          `${context.application.data.prefix}-${resolved.kind === "scenario" ? "SI" : "FI"}`,
        );
    selected.push({ reference, target, allocation });
  }
  return selected;
}
