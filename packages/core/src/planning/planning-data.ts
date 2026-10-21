/**
 * Проверка сохранённого JSON перед предметным чтением или изменением планирования.
 * Повреждение формы отличается от неверного внешнего ввода, а связанные записи здесь не читаются.
 */
import {
  PLAN_STATUSES,
  RELEASE_STATUSES,
  RelayError,
  validateActor,
  type EntityRecord,
  type WorkPlanRecord,
  type ReleaseRecord,
  type PlanningRecord,
  type WorkPlanData,
  type ReleaseData,
  type PlanStage,
} from "@relay/contracts";
import {
  choice,
  invalid,
  object,
  text,
  reference,
  references,
  scope,
  uniqueList,
  plannedFor,
  participants,
} from "./planning-validation";
import { planFields, planningLimits, releaseFields } from "./planning.constants";
import { planningMessages } from "./planning.messages";

export { openPlan, stageIndex } from "./planning-rules";

/**
 * Декодирует временную отметку; null означает, что событие жизненного цикла ещё не наступило.
 */
function timestamp(value: unknown, field: string): string | null {
  if (value === null) {
    return null;
  }
  const date = text(value, field, {
    maxLength: planningLimits.timestampLength,
    required: true,
    singleLine: true,
  });
  if (!Number.isFinite(Date.parse(date))) {
    invalid(planningMessages.invalidTimestamp(field));
  }
  return date;
}

/**
 * Декодирует полный сохранённый этап с уникальными строковыми ID задач.
 */
function stage(value: unknown): PlanStage {
  const fields = object(value, [
    "id",
    "title",
    "summary",
    "outcome",
    "completionConditions",
    "taskIds",
  ]);
  return {
    id: reference(fields.id, "stage.id"),
    title: text(fields.title, "stage.title", {
      maxLength: planningLimits.titleLength,
      required: true,
      singleLine: true,
    }),
    summary: text(fields.summary, "stage.summary", { maxLength: planningLimits.summaryLength }),
    outcome: text(fields.outcome, "stage.outcome"),
    completionConditions: text(fields.completionConditions, "stage.completionConditions"),
    taskIds: references(fields.taskIds, "stage.taskIds", planningLimits.stageTasks),
  };
}

/**
 * Декодирует полный план и запрещает повтор задачи между его этапами.
 * Создаёт новые вложенные объекты и списки, не меняя исходный JSON.
 */
function workPlanData(value: unknown): WorkPlanData {
  const fields = object(value, [
    ...planFields,
    "projectId",
    "stages",
    "result",
    "status",
    "startedAt",
    "closedAt",
  ]);
  const stages = uniqueList(
    fields.stages,
    "stages",
    planningLimits.stages,
    stage,
    (item) => item.id,
  );
  const taskIds = stages.flatMap((item) => item.taskIds);
  if (new Set(taskIds).size !== taskIds.length) {
    invalid(planningMessages.duplicateStageTask);
  }
  return {
    projectId: reference(fields.projectId, "projectId"),
    title: text(fields.title, "title", {
      maxLength: planningLimits.titleLength,
      required: true,
      singleLine: true,
    }),
    summary: text(fields.summary, "summary", { maxLength: planningLimits.summaryLength }),
    goal: text(fields.goal, "goal"),
    rationale: text(fields.rationale, "rationale"),
    boundaries: text(fields.boundaries, "boundaries"),
    expectedResult: text(fields.expectedResult, "expectedResult"),
    participants: participants(fields.participants),
    scope: scope(fields.scope),
    stages,
    result: text(fields.result, "result"),
    status: choice(fields.status, PLAN_STATUSES, "status"),
    startedAt: timestamp(fields.startedAt, "startedAt"),
    closedAt: timestamp(fields.closedAt, "closedAt"),
  };
}

/**
 * Декодирует полный релиз с непустым составом планов; связанные планы здесь не разрешаются.
 */
function releaseData(value: unknown): ReleaseData {
  const fields = object(value, [
    ...releaseFields,
    "projectId",
    "status",
    "releasedAt",
    "releasedBy",
  ]);
  return {
    projectId: reference(fields.projectId, "projectId"),
    title: text(fields.title, "title", {
      maxLength: planningLimits.titleLength,
      required: true,
      singleLine: true,
    }),
    version: text(fields.version, "version", {
      maxLength: planningLimits.versionLength,
      required: true,
      singleLine: true,
    }),
    summary: text(fields.summary, "summary", { maxLength: planningLimits.summaryLength }),
    description: text(fields.description, "description"),
    planIds: references(
      fields.planIds,
      "planIds",
      planningLimits.releasePlans,
      planningLimits.minimumReleasePlans,
    ),
    plannedFor: plannedFor(fields.plannedFor),
    status: choice(fields.status, RELEASE_STATUSES, "status"),
    releasedAt: timestamp(fields.releasedAt, "releasedAt"),
    releasedBy: fields.releasedBy === null ? null : validateActor(fields.releasedBy),
  };
}

/**
 * Возвращает новую проверенную запись нужного проекта, не изменяя исходный объект.
 * Ошибки формы преобразуются в CORRUPT_DATA с исходной причиной; неожиданные ошибки сохраняются.
 */
export function decodePlanning(record: Readonly<EntityRecord>, projectId: string): PlanningRecord {
  try {
    let decoded: PlanningRecord;
    if (record.kind === "work-plan") {
      decoded = { ...record, kind: record.kind, data: workPlanData(record.data) };
    } else if (record.kind === "release") {
      decoded = { ...record, kind: record.kind, data: releaseData(record.data) };
    } else {
      invalid(planningMessages.expectedPlanning);
    }
    if (decoded.data.projectId !== projectId) {
      invalid(planningMessages.wrongProject);
    }
    return decoded;
  } catch (error) {
    if (
      !(error instanceof RelayError) ||
      !["VALIDATION_ERROR", "INVALID_ARGUMENT"].includes(error.code)
    ) {
      throw error;
    }
    const failure = new RelayError(
      "CORRUPT_DATA",
      planningMessages.corruptData(record.key, error.message),
      1,
      {
        id: record.id,
      },
    );
    failure.cause = error;
    throw failure;
  }
}

/**
 * Декодирует запись как план; несовпадающий вид также считается повреждением хранения.
 */
export function decodePlan(record: Readonly<EntityRecord>, projectId: string): WorkPlanRecord {
  const decoded = decodePlanning(record, projectId);
  if (decoded.kind !== "work-plan") {
    throw new RelayError("CORRUPT_DATA", planningMessages.expectedPlan, 1);
  }
  return decoded;
}

/**
 * Декодирует запись как релиз; несовпадающий вид также считается повреждением хранения.
 */
export function decodeRelease(record: Readonly<EntityRecord>, projectId: string): ReleaseRecord {
  const decoded = decodePlanning(record, projectId);
  if (decoded.kind !== "release") {
    throw new RelayError("CORRUPT_DATA", planningMessages.expectedRelease, 1);
  }
  return decoded;
}
