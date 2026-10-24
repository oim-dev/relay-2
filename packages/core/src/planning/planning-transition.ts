import { isDeepStrictEqual } from "node:util";
import {
  RelayError,
  validateActor,
  type PlanningRecord,
  type ReleaseRecord,
  type WorkPlanRecord,
} from "@relay/contracts";
import { planFields, releaseFields } from "./planning.constants";
import { planningMessages } from "./planning.messages";
import { resolveReleasePlans } from "./planning-preparation";
import { planProgress, releaseProgress } from "./planning-progress";
import {
  assertPlanCanStart,
  assertPlanningMutable,
  assertStageEmpty,
  assertTaskAvailable,
  openPlan,
} from "./planning-rules";
import type { PlanningTransitionContext } from "./planning-transition.types";
import { assertPlanningTransitionTargets } from "./planning-transition-targets";

/**
 * Отклоняет неподдерживаемое ребро или изменение чужих полей уже рассчитанного эффекта.
 */
function invalidTransition(): never {
  throw new RelayError("INVALID_TRANSITION", planningMessages.invalidTransition, 4);
}

/**
 * Требует явное основание перехода, не подставляя пустой результат вместо пропущенного чтения.
 */
function required<T>(value: T | undefined): T {
  if (value === undefined) {
    throw new RelayError("CORRUPT_DATA", planningMessages.missingContext);
  }
  return value;
}

/**
 * Защищает поля содержания, не принадлежащие выбранной предметной операции.
 */
function unchangedExcept(
  before: Readonly<Record<string, unknown>>,
  after: Readonly<Record<string, unknown>>,
  allowed: readonly string[],
): void {
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (!allowed.includes(key) && !isDeepStrictEqual(before[key], after[key])) {
      invalidTransition();
    }
  }
}

/**
 * Проверяет новые ссылки области и новые адреса включений на готовых данных boundary.
 * Исторические включения закрытых планов не резервируют задачу.
 */
function assertPlanComposition(
  previous: Readonly<WorkPlanRecord> | null,
  next: Readonly<WorkPlanRecord>,
  context: PlanningTransitionContext,
): void {
  if (!isDeepStrictEqual(previous?.data.scope ?? [], next.data.scope)) {
    const targets = required(context.scope);
    for (const entry of next.data.scope) {
      if (!targets.some((target) => target.id === entry.id && target.kind === entry.kind)) {
        throw new RelayError("NOT_FOUND", planningMessages.missingScope, 3, { ref: entry.id });
      }
    }
  }
  const stages = new Map(next.data.stages.map((stage) => [stage.id, stage]));
  for (const stage of previous?.data.stages ?? []) {
    if (!stages.has(stage.id)) {
      assertStageEmpty(stage);
    }
  }
  const oldStages = new Map(previous?.data.stages.map((stage) => [stage.id, stage]) ?? []);
  for (const stage of next.data.stages) {
    for (const taskId of stage.taskIds) {
      const added = !oldStages.get(stage.id)?.taskIds.includes(taskId);
      const repeatedMembership =
        ["plan.stage.task.add", "plan.stage.task.transfer"].includes(context.operation) &&
        (context.taskId === undefined ? context.taskIds?.has(taskId) : context.taskId === taskId);
      if (!added && !repeatedMembership) {
        continue;
      }
      if (!required(context.taskIds).has(taskId)) {
        throw new RelayError("NOT_FOUND", planningMessages.missingTaskProgress, 3, { taskId });
      }
      if (openPlan(next)) {
        assertTaskAvailable(
          required(context.memberships).filter((plan) => plan.id !== next.id),
          taskId,
          {
            planId: next.id,
            stageId: stage.id,
          },
        );
      }
    }
  }
}

/**
 * Проверяет жизненный цикл плана по фактическому ребру и имени команды, без повторения ввода.
 */
function assertPlanTransition(
  previous: Readonly<WorkPlanRecord> | null,
  next: Readonly<WorkPlanRecord>,
  context: PlanningTransitionContext,
): void {
  const operation = context.operation;
  if (previous === null) {
    if (
      !["plan.create", "replication"].includes(operation) ||
      next.data.status !== "draft" ||
      next.data.stages.length !== 0 ||
      next.data.startedAt !== null ||
      next.data.closedAt !== null ||
      next.data.result !== ""
    ) {
      invalidTransition();
    }
    assertPlanComposition(null, next, context);
    return;
  }
  assertPlanningMutable(previous);
  const changedStatus = previous.data.status !== next.data.status;
  const allowed: string[] = operation === "replication" ? [...planFields, "stages"] : [];
  if (
    changedStatus &&
    !["replication", "plan.start", "plan.complete", "plan.cancel"].includes(operation)
  ) {
    invalidTransition();
  }
  if (operation === "plan.update") {
    allowed.push(...planFields);
  } else if (operation.startsWith("plan.stage.")) {
    if (
      ![
        "plan.stage.create",
        "plan.stage.update",
        "plan.stage.remove",
        "plan.stage.move",
        "plan.stage.task.add",
        "plan.stage.task.remove",
        "plan.stage.task.transfer",
      ].includes(operation)
    ) {
      invalidTransition();
    }
    allowed.push("stages");
    assertPlanningTransitionTargets(previous, next, context);
  } else if (["plan.start", "plan.complete", "plan.cancel"].includes(operation)) {
    const status =
      operation === "plan.start"
        ? "active"
        : operation === "plan.complete"
          ? "completed"
          : "cancelled";
    if (!changedStatus || next.data.status !== status) {
      invalidTransition();
    }
  } else if (operation !== "replication") {
    invalidTransition();
  }
  if (changedStatus) {
    if (next.data.status === "active") {
      assertPlanCanStart({ ...next, data: { ...next.data, status: previous.data.status } });
      if (next.data.startedAt === null) {
        invalidTransition();
      }
      allowed.push("status", "startedAt");
    } else if (next.data.status === "completed" || next.data.status === "cancelled") {
      if (!next.data.result.trim() || next.data.closedAt === null) {
        invalidTransition();
      }
      if (next.data.status === "completed") {
        const progress = planProgress(next, required(context.taskProgress));
        if (!progress.completed) {
          throw new RelayError("NOT_READY", planningMessages.planNotReady, 4, { progress });
        }
      }
      allowed.push("status", "result", "closedAt");
    } else {
      invalidTransition();
    }
  }
  unchangedExcept(previous.data, next.data, allowed);
  assertPlanComposition(previous, next, context);
}

/**
 * Выбирает полный состав в сохранённом порядке и не скрывает отсутствующий план.
 */
function selectedPlans(
  next: Readonly<ReleaseRecord>,
  context: PlanningTransitionContext,
): WorkPlanRecord[] {
  const plans = new Map(required(context.plans).map((plan) => [plan.id, plan]));
  return next.data.planIds.map((id) => {
    const plan = plans.get(id);
    if (plan === undefined) {
      throw new RelayError("NOT_FOUND", planningMessages.missingPlan, 3, {
        ref: id,
        kind: "work-plan",
      });
    }
    return plan;
  });
}

/**
 * Проверяет состояние релиза и актуальные основания только нового выпуска или перепланирования.
 */
function assertReleaseTransition(
  previous: Readonly<ReleaseRecord> | null,
  next: Readonly<ReleaseRecord>,
  context: PlanningTransitionContext,
): void {
  const operation = context.operation;
  if (previous === null) {
    if (
      !["release.create", "replication"].includes(operation) ||
      next.data.status !== "planned" ||
      next.data.releasedAt !== null ||
      next.data.releasedBy !== null
    ) {
      invalidTransition();
    }
    resolveReleasePlans(selectedPlans(next, context));
    return;
  }
  assertPlanningMutable(previous);
  const changedStatus = previous.data.status !== next.data.status;
  const allowed: string[] =
    operation === "replication" || operation === "release.update" ? [...releaseFields] : [];
  if (["release.plan", "release.cancel", "release.publish"].includes(operation)) {
    const status =
      operation === "release.plan"
        ? "planned"
        : operation === "release.cancel"
          ? "cancelled"
          : "released";
    if (next.data.status !== status) {
      invalidTransition();
    }
  } else if (operation !== "replication" && operation !== "release.update") {
    invalidTransition();
  }
  if (changedStatus) {
    if (operation === "release.update") {
      invalidTransition();
    }
    allowed.push("status");
    if (next.data.status === "released") {
      if (previous.data.status !== "planned") {
        throw new RelayError("INVALID_TRANSITION", planningMessages.releaseRequiresReplanning, 4);
      }
      const progress = releaseProgress(
        selectedPlans(next, context),
        required(context.taskProgress),
      );
      if (!progress.completed) {
        throw new RelayError("NOT_READY", planningMessages.releaseNotReady, 4, { progress });
      }
      if (next.data.releasedAt === null || next.data.releasedBy !== context.actor) {
        invalidTransition();
      }
      allowed.push("releasedAt", "releasedBy");
    } else if (next.data.status === "planned") {
      resolveReleasePlans(selectedPlans(next, context));
    }
  }
  if (!isDeepStrictEqual(previous.data.planIds, next.data.planIds)) {
    resolveReleasePlans(selectedPlans(next, context), new Set(previous.data.planIds));
  }
  unchangedExcept(previous.data, next.data, allowed);
}

/**
 * Единая чистая проверка готовых planning effects для команд и ordered publication.
 * CAS принадлежит локальному executor; этот валидатор не читает БД/часы и не исполняет
 * пользовательскую команду повторно. replication выводит ребро из before/after.
 * Неизменённые исторические owners при изменении чужих задач повторно не передаются.
 */
export function assertPlanningTransition(
  previous: Readonly<PlanningRecord> | null,
  next: Readonly<PlanningRecord>,
  context: PlanningTransitionContext,
): void {
  validateActor(context.actor);
  if (
    previous !== null &&
    (previous.id !== next.id ||
      previous.kind !== next.kind ||
      previous.createdAt !== next.createdAt ||
      previous.createdBy !== next.createdBy ||
      previous.data.projectId !== next.data.projectId)
  ) {
    throw new RelayError("INVALID_TRANSITION", planningMessages.immutableFields, 4);
  }
  if (next.kind === "work-plan" && (previous === null || previous.kind === "work-plan")) {
    assertPlanTransition(previous, next, context);
  } else if (next.kind === "release" && (previous === null || previous.kind === "release")) {
    assertReleaseTransition(previous, next, context);
  } else {
    invalidTransition();
  }
}
