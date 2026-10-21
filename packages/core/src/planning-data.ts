/** Проверка сохранённого JSON перед предметным чтением или изменением планирования. */
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
  planFields,
  releaseFields,
  text,
  reference,
  references,
  scope,
  uniqueList,
  plannedFor,
} from "./planning-input";

function timestamp(value: unknown, field: string): string | null {
  if (value === null) return null;
  const date = text(value, field, 32, true, true);
  if (!Number.isFinite(Date.parse(date))) invalid(`Повреждена дата ${field}.`);
  return date;
}

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
    title: text(fields.title, "stage.title", 160, true, true),
    summary: text(fields.summary, "stage.summary", 16 * 1024),
    outcome: text(fields.outcome, "stage.outcome"),
    completionConditions: text(fields.completionConditions, "stage.completionConditions"),
    taskIds: references(fields.taskIds, "stage.taskIds", 2000),
  };
}

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
  const stages = uniqueList(fields.stages, "stages", 200, stage, (item) => item.id);
  const taskIds = stages.flatMap((item) => item.taskIds);
  if (new Set(taskIds).size !== taskIds.length)
    invalid("Повторное включение задачи в этапы плана.");
  return {
    projectId: reference(fields.projectId, "projectId"),
    title: text(fields.title, "title", 160, true, true),
    summary: text(fields.summary, "summary", 16 * 1024),
    goal: text(fields.goal, "goal"),
    rationale: text(fields.rationale, "rationale"),
    boundaries: text(fields.boundaries, "boundaries"),
    expectedResult: text(fields.expectedResult, "expectedResult"),
    participants: uniqueList(
      fields.participants,
      "participants",
      100,
      (item) => text(item, "participants", 160, true, true),
      (item) => item,
    ),
    scope: scope(fields.scope),
    stages,
    result: text(fields.result, "result"),
    status: choice(fields.status, PLAN_STATUSES, "status"),
    startedAt: timestamp(fields.startedAt, "startedAt"),
    closedAt: timestamp(fields.closedAt, "closedAt"),
  };
}

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
    title: text(fields.title, "title", 160, true, true),
    version: text(fields.version, "version", 80, true, true),
    summary: text(fields.summary, "summary", 16 * 1024),
    description: text(fields.description, "description"),
    planIds: references(fields.planIds, "planIds", 200, 1),
    plannedFor: plannedFor(fields.plannedFor),
    status: choice(fields.status, RELEASE_STATUSES, "status"),
    releasedAt: timestamp(fields.releasedAt, "releasedAt"),
    releasedBy: fields.releasedBy === null ? null : validateActor(fields.releasedBy),
  };
}

/** Возвращает новый проверенный объект; ошибку формы хранения не выдаёт за неверный ввод. */
export function decodePlanning(record: EntityRecord, projectId: string): PlanningRecord {
  try {
    let decoded: PlanningRecord;
    if (record.kind === "work-plan")
      decoded = { ...record, kind: record.kind, data: workPlanData(record.data) };
    else if (record.kind === "release")
      decoded = { ...record, kind: record.kind, data: releaseData(record.data) };
    else invalid("Ожидается план или релиз.");
    if (decoded.data.projectId !== projectId) invalid("Планирование принадлежит другому проекту.");
    return decoded;
  } catch (error) {
    if (
      !(error instanceof RelayError) ||
      !["VALIDATION_ERROR", "INVALID_ARGUMENT"].includes(error.code)
    )
      throw error;
    throw new RelayError("CORRUPT_DATA", `Повреждены данные ${record.key}: ${error.message}`, 1, {
      id: record.id,
    });
  }
}

export function decodePlan(record: EntityRecord, projectId: string): WorkPlanRecord {
  const decoded = decodePlanning(record, projectId);
  if (decoded.kind !== "work-plan") throw new RelayError("CORRUPT_DATA", "Ожидается план.", 1);
  return decoded;
}

export function decodeRelease(record: EntityRecord, projectId: string): ReleaseRecord {
  const decoded = decodePlanning(record, projectId);
  if (decoded.kind !== "release") throw new RelayError("CORRUPT_DATA", "Ожидается релиз.", 1);
  return decoded;
}

export function openPlan(plan: WorkPlanRecord): boolean {
  return plan.data.status === "draft" || plan.data.status === "active";
}

export function stageIndex(stages: readonly PlanStage[], stageId: string): number {
  const index = stages.findIndex((item) => item.id === stageId);
  if (index < 0)
    throw new RelayError("NOT_FOUND", "Этап не найден в указанном плане.", 3, { stageId });
  return index;
}
