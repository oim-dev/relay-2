import {
  RelayError,
  type BatchResult,
  type BatchItemResult,
  type CommandCommitFacts,
  type EntityRecord,
  type ProjectEntity,
} from "@relay/contracts";
import { projectDocumentSection } from "../knowledge/document-sections";
import { decodeEntityRecord } from "../projections/entity-record";
import type { CommandResultMaterial } from "./command-result.types";
import { commandMessages } from "./command.messages";

/**
 * Чисто декодирует одну итоговую карточку; никакого ленивого чтения проекта или журнала.
 */
function decodeResultRecord(
  record: EntityRecord,
  material: CommandResultMaterial,
  facts: CommandCommitFacts,
): ProjectEntity {
  if (material.freshTaskIds.includes(record.id)) {
    record = freshTaskRecord(record.id, facts);
  }
  if (record.kind === "task") {
    const comments = facts.comments.get(record.id);
    if (comments === undefined) {
      throw new RelayError("CORRUPT_DATA", commandMessages.observation, 1, { id: record.id });
    }
    record = { ...record, data: { ...record.data, comments: [...comments] } };
  }
  const decoded = decodeEntityRecord(record, material.projectId);
  if (decoded.kind !== "document") {
    return decoded;
  }
  if (material.sections === undefined) {
    throw new RelayError("CORRUPT_DATA", commandMessages.observation);
  }
  return projectDocumentSection(decoded, material.sections);
}

/**
 * Получает только явно запрошенную карточку append-only владельца из commit-снимка.
 */
function freshTaskRecord(id: string, facts: CommandCommitFacts): EntityRecord {
  const task = facts.taskRecords.get(id);
  if (task === undefined || task.id !== id || task.kind !== "task") {
    throw new RelayError("CORRUPT_DATA", commandMessages.observation, 1, { id });
  }
  return task;
}

/**
 * Завершает компактный результат append-only шага фактической версией владельца.
 * У content-изменений и исторических checkpoints первоначальные ревизии шагов не меняются.
 */
function finalizeCommandItem(
  item: BatchItemResult,
  material: CommandResultMaterial,
  facts: CommandCommitFacts,
): BatchItemResult {
  const copied = structuredClone(item);
  if (item.op !== "task.comment.add" || !material.freshTaskIds.includes(item.owner.id)) {
    return copied;
  }
  const task = freshTaskRecord(item.owner.id, facts);
  return {
    ...copied,
    revision: task.revision,
    owner: { ...copied.owner, key: task.key, revision: task.revision },
    outputs: copied.outputs.map((output) =>
      output.kind === "task" && output.id === task.id
        ? { ...output, key: task.key, revision: task.revision }
        : output,
    ),
  };
}

/**
 * Собирает первоначальный результат внутри commit только из подготовленных карточек и фактов.
 * Исторические step-items и checkpoints остаются снимками своих шагов.
 */
export function finalizeCommandResult(
  material: CommandResultMaterial,
  facts: CommandCommitFacts,
): BatchResult {
  return {
    operationKey: material.operationKey,
    status: material.check ? "checked" : "committed",
    replayed: false,
    items: material.items.map((item) => finalizeCommandItem(item, material, facts)),
    entities: material.records.map((record) =>
      decodeResultRecord(structuredClone(record), material, facts),
    ),
  };
}
