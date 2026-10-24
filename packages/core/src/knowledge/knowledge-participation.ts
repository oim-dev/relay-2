import {
  RelayError,
  type CommandEffect,
  type KnowledgeRecord,
  type WriteOptions,
} from "@relay/contracts";
import { changeCommandEntity, createCommandEntity } from "../commands/command-entity";
import { knowledgeCommandEffect } from "./knowledge-transition";
import { decodeKnowledge } from "./knowledge-data";
import { requireKnowledgeAddresses } from "./knowledge-command-addresses";
import type {
  KnowledgeAllocation,
  KnowledgeDelta,
  KnowledgeParticipationContext,
  KnowledgeParticipationDelta,
  KnowledgeParticipationSelection,
} from "./knowledge-command.types";
import {
  requireApplicationImplementations,
  requireFeatureParticipation,
  requireImplementationTarget,
  requireKnowledgeRevision,
  requireParticipationSelection,
} from "./knowledge-rules";
import { knowledgeMessages } from "./knowledge.messages";
import type {
  ImplementationContent,
  ImplementationTarget,
  KnowledgeReference,
} from "./knowledge.types";
import { invalidKnowledge } from "./knowledge-validation";

/**
 * Формирует FI/SI с постоянными ссылками и выделенными заранее метаданными.
 */
function calculateImplementation(
  application: KnowledgeRecord<"application">,
  target: ImplementationTarget,
  data: ImplementationContent,
  allocation: KnowledgeAllocation,
): KnowledgeRecord<"implementation"> {
  requireKnowledgeAddresses("implementation", allocation.id, allocation.addresses);
  return decodeKnowledge(
    createCommandEntity(
      "implementation",
      allocation.key,
      {
        ...data,
        targetId: target.id,
        targetKind: target.kind,
        featureId: target.kind === "feature" ? target.id : target.data.featureId,
        ...(target.kind === "scenario" ? { scenarioId: target.id } : {}),
        applicationId: application.id,
        active: true,
      },
      allocation,
    ),
    "implementation",
  );
}

/**
 * Рассчитывает создание реализации вместе с CAS владельца состава; прежнее участие не дублируется.
 */
export function calculateImplementationCreation(
  context: KnowledgeParticipationContext,
  reference: KnowledgeReference,
  data: ImplementationContent,
  allocation: KnowledgeAllocation,
  write: WriteOptions,
): KnowledgeDelta<"implementation"> {
  const { application, existing } = context;
  requireKnowledgeRevision(application, write.ifRevision);
  requireApplicationImplementations(application, existing);
  const target = requireImplementationTarget(reference);
  if (existing.some((record) => record.data.targetId === target.id)) {
    throw new RelayError("ALREADY_EXISTS", knowledgeMessages.participationExists, 4);
  }
  requireFeatureParticipation(target, existing);
  const record = calculateImplementation(application, target, data, allocation);
  const owner = changeCommandEntity(
    application,
    {
      implementationIds: [...application.data.implementationIds, record.id].sort(),
    },
    write,
    allocation.timestamp,
  );
  return {
    record,
    effects: [
      ...knowledgeCommandEffect(null, record, "implementation.create"),
      ...knowledgeCommandEffect(application, owner, "implementation.create"),
    ],
  };
}

/**
 * Проверяет выбранную FI/SI на принадлежность и возвращает её загруженную исходную цель.
 */
export function participationTarget(
  selection: KnowledgeParticipationSelection,
  applicationId: string,
): ImplementationTarget {
  const { reference, target } = selection;
  if (reference.kind === "implementation") {
    if (reference.data.applicationId !== applicationId) {
      invalidKnowledge(knowledgeMessages.foreignImplementation);
    }
    if (target === null) {
      throw new RelayError("CORRUPT_DATA", knowledgeMessages.targetRequired);
    }
    return requireImplementationTarget(target);
  }
  if (reference.kind !== "feature" && reference.kind !== "scenario") {
    invalidKnowledge(knowledgeMessages.participationTarget);
  }
  return reference;
}

/**
 * Чистая замена участия: проверяет весь состав, восстанавливает историю и возвращает точную delta.
 * Неизменённые реализации не входят в changed/effects; приложение проверяется до no-op.
 */
export function calculateParticipationReplacement(
  context: KnowledgeParticipationContext,
  selection: readonly KnowledgeParticipationSelection[],
  write: WriteOptions,
  timestamp: string,
): KnowledgeParticipationDelta {
  const { application, existing } = context;
  requireKnowledgeRevision(application, write.ifRevision);
  requireApplicationImplementations(application, existing);
  const selected = selection.map((entry) => ({
    entry,
    target: participationTarget(entry, application.id),
  }));
  requireParticipationSelection(selected.map(({ target }) => target));
  const byTarget = new Map<string, KnowledgeRecord<"implementation">>();
  for (const implementation of existing) {
    if (!byTarget.has(implementation.data.targetId)) {
      byTarget.set(implementation.data.targetId, implementation);
    }
  }
  const effects: CommandEffect[] = [];
  const changed: KnowledgeRecord<"implementation">[] = [];
  const active: string[] = [];
  for (const { entry, target } of selected) {
    const previous = byTarget.get(target.id);
    let next: KnowledgeRecord<"implementation">;
    if (previous !== undefined) {
      next = decodeKnowledge(
        changeCommandEntity(
          previous,
          { active: true },
          {
            actor: write.actor,
            ifRevision: previous.revision,
          },
          timestamp,
        ),
        "implementation",
      );
    } else {
      if (entry.allocation === null) {
        throw new RelayError("CORRUPT_DATA", knowledgeMessages.participationMismatch);
      }
      next = calculateImplementation(
        application,
        target,
        {
          title: target.data.name,
          description: "",
          status: "none",
        },
        entry.allocation,
      );
    }
    const delta = knowledgeCommandEffect(
      previous ?? null,
      next,
      "application.participation.replace",
    );
    effects.push(...delta);
    if (delta.length > 0) {
      changed.push(next);
    }
    active.push(next.id);
  }
  const selectedIds = new Set(selected.map(({ target }) => target.id));
  for (const previous of existing) {
    if (selectedIds.has(previous.data.targetId) || !previous.data.active) {
      continue;
    }
    const next = decodeKnowledge(
      changeCommandEntity(
        previous,
        { active: false },
        {
          actor: write.actor,
          ifRevision: previous.revision,
        },
        timestamp,
      ),
      "implementation",
    );
    effects.push(...knowledgeCommandEffect(previous, next, "application.participation.replace"));
    changed.push(next);
  }
  const record = decodeKnowledge(
    changeCommandEntity(
      application,
      {
        implementationIds: active.sort(),
      },
      write,
      timestamp,
    ),
    "application",
  );
  effects.push(...knowledgeCommandEffect(application, record, "application.participation.replace"));
  return { record, effects, changed };
}
