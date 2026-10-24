import type {
  PlanningRecord,
  WorkPlanRecord,
  ReleaseRecord,
  WorkPlanData,
  ReleaseData,
  WriteOptions,
} from "@relay/contracts";
import {
  changeCommandEntity,
  createCommandEntity,
  entityCommandEffect,
} from "../commands/command-entity";
import { decodePlan, decodeRelease } from "./planning-data";
import {
  newPlanData,
  newReleaseData,
  preparePlanFields,
  prepareReleaseFields,
} from "./planning-preparation";
import { assertPlanningWritable } from "./planning-rules";
import { assertPlanningTransition } from "./planning-transition";
import { invalid } from "./planning-validation";
import { planningMessages } from "./planning.messages";
import type {
  PlanningCreationAllocation,
  PlanningDelta,
  PlanningFieldsContext,
} from "./planning-command.types";
import type { PlanningTransitionContext } from "./planning-transition.types";

/**
 * Создаёт точный эффект плана или релиза из согласованных значений и выделенных метаданных.
 */
export function calculatePlanningCreation(
  context: PlanningFieldsContext,
  allocation: PlanningCreationAllocation,
): PlanningDelta {
  const data =
    context.kind === "work-plan"
      ? newPlanData(preparePlanFields(context.fields, context.scope), allocation.projectId)
      : newReleaseData(prepareReleaseFields(context.fields, context.plans), allocation.projectId);
  const raw = createCommandEntity(context.kind, allocation.key, data, allocation);
  const record =
    context.kind === "work-plan"
      ? decodePlan(raw, allocation.projectId)
      : decodeRelease(raw, allocation.projectId);
  assertPlanningTransition(null, record, {
    actor: allocation.actor,
    operation: context.kind === "work-plan" ? "plan.create" : "release.create",
    ...context,
  });
  return { record, effects: entityCommandEffect(null, record) };
}

/**
 * Проверяет CAS до readonly/no-op и рассчитывает только переданные поля владельца.
 */
export function calculatePlanningUpdate(
  current: PlanningRecord,
  context: PlanningFieldsContext,
  write: Readonly<WriteOptions>,
  timestamp: string,
): PlanningDelta {
  assertPlanningWritable(current, write);
  if (current.kind === "work-plan" && context.kind === "work-plan") {
    const fields = preparePlanFields(context.fields, context.scope);
    if (!Object.keys(fields).length) {
      invalid(planningMessages.emptyUpdate);
    }
    return calculatePlanPatch(current, fields, write, timestamp, {
      operation: "plan.update",
      actor: write.actor,
      scope: context.scope,
    });
  }
  if (current.kind === "release" && context.kind === "release") {
    const fields = prepareReleaseFields(
      context.fields,
      context.plans,
      new Set(current.data.planIds),
    );
    if (!Object.keys(fields).length) {
      invalid(planningMessages.emptyUpdate);
    }
    return calculateReleasePatch(current, fields, write, timestamp, {
      operation: "release.update",
      actor: write.actor,
      plans: context.plans,
    });
  }
  invalid(planningMessages.expectedPlanning);
}

/**
 * Общий чистый путь плана: новая карточка, единый transition validator, точный sparse effect.
 */
export function calculatePlanPatch(
  current: WorkPlanRecord,
  fields: Readonly<Partial<WorkPlanData>>,
  write: Readonly<WriteOptions>,
  timestamp: string,
  context: PlanningTransitionContext,
): PlanningDelta<WorkPlanRecord> {
  assertPlanningWritable(current, write);
  const record = decodePlan(
    changeCommandEntity(current, fields, write, timestamp),
    current.data.projectId,
  );
  assertPlanningTransition(current, record, context);
  return { record, effects: entityCommandEffect(current, record) };
}

/**
 * Общий чистый путь релиза; выбранные планы не изменяются, no-op сохраняет revision.
 */
export function calculateReleasePatch(
  current: ReleaseRecord,
  fields: Readonly<Partial<ReleaseData>>,
  write: Readonly<WriteOptions>,
  timestamp: string,
  context: PlanningTransitionContext,
): PlanningDelta<ReleaseRecord> {
  assertPlanningWritable(current, write);
  const record = decodeRelease(
    changeCommandEntity(current, fields, write, timestamp),
    current.data.projectId,
  );
  assertPlanningTransition(current, record, context);
  return { record, effects: entityCommandEffect(current, record) };
}
