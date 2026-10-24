import {
  RelayError,
  type StageChange,
  type WorkPlanRecord,
  type WriteOptions,
} from "@relay/contracts";
import { changeCommandEntity, entityCommandEffect } from "../commands/command-entity";
import { taskRecord } from "../tasks/task-data";
import { decodePlan } from "./planning-data";
import { calculatePlanPatch } from "./planning-command-calculate";
import { assertPlanningWritable, assertTaskAvailable, requireStage } from "./planning-rules";
import { changeStages, changeStageTask, transferStageTask } from "./planning-stages";
import { assertPlanningTransition } from "./planning-transition";
import { planningMessages } from "./planning.messages";
import type {
  PlanningDelta,
  PlanningMembershipContext,
  PlanningTransferContext,
  PlanningTransferDelta,
  CheckedPlanTransferWriteOptions,
} from "./planning-command.types";

/**
 * Рассчитывает этапы с заранее выделенным ID; исходный CAS предшествует readonly и no-op.
 */
export function calculatePlanningStage(
  current: WorkPlanRecord,
  change: Readonly<StageChange>,
  stageId: string | null,
  write: Readonly<WriteOptions>,
  timestamp: string,
): PlanningDelta<WorkPlanRecord> {
  assertPlanningWritable(current, write);
  const stages = changeStages(current.data.stages, change, stageId);
  const selectedStageId = change.action === "create" ? stageId : change.stageId;
  return calculatePlanPatch(current, { stages }, write, timestamp, {
    operation: `plan.stage.${change.action}`,
    actor: write.actor,
    ...(selectedStageId === null ? {} : { stageId: selectedStageId }),
    ...(change.action === "create" ? { beforeStageId: change.before } : {}),
    ...(change.action === "move" && "before" in change.destination
      ? { beforeStageId: change.destination.before }
      : {}),
  });
}

/**
 * Рассчитывает включение/исключение только выбранной задачи без полного каталога планов.
 * Даже повтор включения проверяет весь выбранный membership predicate до no-op.
 */
export function calculatePlanningMembership(
  current: WorkPlanRecord,
  stageId: string,
  remove: boolean,
  context: PlanningMembershipContext,
  write: Readonly<WriteOptions>,
  timestamp: string,
): PlanningDelta<WorkPlanRecord> {
  assertPlanningWritable(current, write);
  const stage = requireStage(current.data.stages, stageId);
  const task = taskRecord(context.task);
  if (!remove) {
    assertTaskAvailable(context.memberships, task.id, { planId: current.id, stageId });
  }
  const stages = changeStageTask(
    current.data.stages,
    stage,
    task.id,
    remove ? "remove" : "include",
  );
  return calculatePlanPatch(current, { stages: stages ?? current.data.stages }, write, timestamp, {
    operation: `plan.stage.task.${remove ? "remove" : "add"}`,
    actor: write.actor,
    memberships: context.memberships,
    taskIds: new Set([task.id]),
    stageId,
    taskId: task.id,
  });
}

/**
 * Рассчитывает обе стороны переноса один раз. Оба клиентских CAS обязательны и при
 * совпадающем плане, но effect владельца в этом случае ровно один. Задача не меняется.
 */
export function calculatePlanningTransfer(
  context: PlanningTransferContext,
  write: CheckedPlanTransferWriteOptions,
  timestamp: string,
): PlanningTransferDelta {
  const { source, target, input } = context;
  const sourceWrite = { actor: write.actor, ifRevision: write.ifRevision };
  const targetWrite = { actor: write.actor, ifRevision: write.targetRevision };
  assertPlanningWritable(source, sourceWrite);
  assertPlanningWritable(target, targetWrite);
  const task = taskRecord(context.task);
  const sourceStage = source.data.stages.find((stage) => stage.taskIds.includes(task.id));
  if (sourceStage === undefined) {
    throw new RelayError("NOT_FOUND", planningMessages.sourceTaskNotFound, 3);
  }
  const targetStage = requireStage(target.data.stages, input.targetStage);
  assertTaskAvailable(context.memberships, task.id, { planId: source.id, stageId: sourceStage.id });
  const stages = transferStageTask(source, target, sourceStage, targetStage, task.id);
  const savedSource = decodePlan(
    changeCommandEntity(
      source,
      { stages: stages?.source ?? source.data.stages },
      sourceWrite,
      timestamp,
    ),
    source.data.projectId,
  );
  const savedTarget =
    source.id === target.id
      ? savedSource
      : decodePlan(
          changeCommandEntity(
            target,
            { stages: stages?.target ?? target.data.stages },
            targetWrite,
            timestamp,
          ),
          target.data.projectId,
        );
  const memberships = [
    ...context.memberships.filter((plan) => plan.id !== source.id && plan.id !== target.id),
    savedSource,
    ...(source.id === target.id ? [] : [savedTarget]),
  ];
  const validation = {
    operation: "plan.stage.task.transfer",
    actor: write.actor,
    memberships,
    taskIds: new Set([task.id]),
    taskId: task.id,
    sourcePlanId: source.id,
    targetPlanId: target.id,
    targetStageId: targetStage.id,
  };
  assertPlanningTransition(source, savedSource, validation);
  assertPlanningTransition(target, savedTarget, validation);
  return {
    source: savedSource,
    target: savedTarget,
    effects: [
      ...entityCommandEffect(source, savedSource),
      ...(source.id === target.id ? [] : entityCommandEffect(target, savedTarget)),
    ],
  };
}
