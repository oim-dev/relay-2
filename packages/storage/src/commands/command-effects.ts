import type { Database } from "bun:sqlite";
import { RelayError, type CommandCommitPlan, type CommandEffect } from "@relay/contracts";
import { getEntityRevision } from "../entities/entity-queries";
import {
  appendComment,
  insertEntity,
  revisionConflict,
  updateEntity,
} from "../entities/entity-writes";
import { entityMessages } from "../entities/entity.messages";
import { replicationFingerprint } from "../replication/portable-version";
import { captureCommandTransition } from "../replication/replication-transitions";
import { commandStorageMessages } from "./command.messages";

/**
 * Сохраняет точный эффект без повторного исполнения предметных методов.
 * CAS использует исходную ревизию; комментарии дописываются независимо от содержимого.
 */
function applyCommandEffect(
  connection: Database,
  effect: CommandEffect,
  allocationId: string,
): void {
  if (effect.kind === "comment") {
    appendComment(connection, effect.taskId, effect.comment);
    return;
  }
  const { before, after } = effect;
  if (before === null) {
    if (after.revision !== 1) {
      throw new RelayError("VALIDATION_ERROR", commandStorageMessages.invalidEffect, 2, {
        id: after.id,
      });
    }
    insertEntity(connection, after, { allocationId });
    return;
  }
  if (before.id !== after.id || after.revision !== before.revision + 1) {
    throw new RelayError("VALIDATION_ERROR", commandStorageMessages.invalidEffect, 2, {
      id: after.id,
    });
  }
  if (!updateEntity(connection, after, before.revision, { allocationId })) {
    const current = getEntityRevision(connection, before.id);
    if (current === undefined) {
      throw new RelayError("NOT_FOUND", entityMessages.entityMissing, 3, { id: before.id });
    }
    throw revisionConflict(current, before.revision);
  }
}

/**
 * Применяет tape последовательно и фиксирует normalized boundary после каждого шага.
 * Идентичности частей выводятся из физической реплики и неизменного подготовленного эффекта.
 * Разные реплики не делят новые назначения; повтор того же плана не читает часы/UUID.
 * Все записи, захват репликации и возможный отказ принадлежат внешней транзакции.
 */
export function applyCommandTransitions(connection: Database, plan: CommandCommitPlan): void {
  for (const transition of plan.transitions) {
    for (const [index, effect] of transition.effects.entries()) {
      const allocationId = replicationFingerprint({
        projectId: plan.projectId,
        replicaId: plan.replicaId,
        actor: plan.actor,
        timestamp: plan.timestamp,
        transition: transition.index,
        effect: index,
        id: effect.kind === "entity" ? effect.after.id : effect.comment.id,
        revision: effect.kind === "entity" ? effect.after.revision : null,
      });
      applyCommandEffect(connection, effect, allocationId);
    }
    captureCommandTransition(connection, transition, plan.actor);
  }
}
