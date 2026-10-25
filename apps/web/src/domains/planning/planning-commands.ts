import type {
  NamedCommand,
  PlanTransition,
  ReleaseInput,
  ReleaseTransition,
  StageChange,
  WorkPlanInput,
} from "@relay/contracts";
import type {
  PlanMembershipChange,
  PlanMembershipSource,
  PlanningSource,
  StageSource,
} from "./planning.types";

/**
 * Сохраняет отсутствие необязательных полей: Core отличает пропуск от явного undefined.
 */
function providedFields(
  fields: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  return Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined));
}

/**
 * Добавляет оба исходных guard владельца, никогда не подменяя их свежей карточкой.
 */
export function guardedPlanningCommand(
  source: PlanningSource,
  op: string,
  input: Readonly<Record<string, unknown>> = {},
): NamedCommand {
  return {
    op,
    ref: source.entity.id,
    ifRevision: source.entity.revision,
    ...(source.expectedVersion === undefined ? {} : { expectedVersion: source.expectedVersion }),
    input,
  };
}

/**
 * Создаёт или меняет только содержание плана; жизненный цикл и этапы имеют отдельные команды.
 */
export function planContentCommand(input: WorkPlanInput, source?: PlanningSource): NamedCommand {
  const fields = providedFields({
    title: input.title,
    summary: input.summary,
    goal: input.goal,
    rationale: input.rationale,
    boundaries: input.boundaries,
    expectedResult: input.expectedResult,
    participants: input.participants,
    scope: input.scope,
  });
  return source === undefined
    ? { op: "plan.create", input: fields }
    : guardedPlanningCommand(source, "plan.update", fields);
}

/**
 * Формирует содержание релиза с непустым составом; готовность проверяется Core при публикации.
 */
export function releaseContentCommand(input: ReleaseInput, source?: PlanningSource): NamedCommand {
  const fields = providedFields({
    title: input.title,
    version: input.version,
    summary: input.summary,
    description: input.description,
    plannedFor: input.plannedFor,
    planIds: input.planIds,
  });
  return source === undefined
    ? { op: "release.create", input: fields }
    : guardedPlanningCommand(source, "release.update", fields);
}

/**
 * Переводит предметный ввод этапа в плоскую схему batch, защищённую ревизией плана.
 */
export function stageCommand(source: StageSource, change: StageChange): NamedCommand {
  switch (change.action) {
    case "create":
      return guardedPlanningCommand(source, "plan.stage.create", {
        ...change.fields,
        before: change.before,
      });
    case "update":
      return guardedPlanningCommand(source, "plan.stage.update", {
        stageId: change.stageId,
        ...change.fields,
      });
    case "move":
      return guardedPlanningCommand(source, "plan.stage.move", {
        stageId: change.stageId,
        ...change.destination,
      });
    case "remove":
      return guardedPlanningCommand(source, "plan.stage.remove", { stageId: change.stageId });
  }
}

/**
 * Адресует состав этапа по CAS плана; transfer сохраняет guards обеих исходных сторон.
 * Задача не получает выдуманную ревизию: её включением владеет план, не карточка задачи.
 */
export function planMembershipCommand(
  source: PlanMembershipSource,
  change: PlanMembershipChange,
): NamedCommand {
  if (change.action !== "transfer") {
    return guardedPlanningCommand(source, `plan.stage.task.${change.action}`, {
      stageId: source.stage.id,
      task: change.task,
    });
  }
  return guardedPlanningCommand(source, "plan.stage.task.transfer", {
    task: change.task,
    targetPlan: change.target.entity.id,
    targetStage: change.targetStage,
    reason: change.reason,
    targetRevision: change.target.entity.revision,
    ...(change.target.expectedVersion === undefined
      ? {}
      : { targetVersion: change.target.expectedVersion }),
  });
}

/**
 * Меняет статус плана с итогом только для закрывающего перехода.
 */
export function planTransitionCommand(
  source: PlanningSource,
  change: PlanTransition,
): NamedCommand {
  return guardedPlanningCommand(
    source,
    `plan.${change.action}`,
    change.action === "start" ? {} : { result: change.result },
  );
}

/**
 * Меняет статус релиза, не затрагивая содержание включённых планов.
 */
export function releaseTransitionCommand(
  source: PlanningSource,
  action: ReleaseTransition,
): NamedCommand {
  return guardedPlanningCommand(source, `release.${action}`);
}
