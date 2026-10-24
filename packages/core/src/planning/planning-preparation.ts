/**
 * Чистая подготовка содержания из проверенных полей и уже загруженных целей.
 * Модуль не читает хранилище, не выделяет ID и не получает текущее время.
 */
import {
  RelayError,
  type ReleaseData,
  type ReleaseFields,
  type WorkPlanData,
  type WorkPlanFields,
  type EntityIdentity,
  type WorkPlanRecord,
} from "@relay/contracts";
import { invalid } from "./planning-validation";
import { planningMessages } from "./planning.messages";

/**
 * Проверяет поля плана и разрешает области воздействия в постоянные ID.
 * Повторы после разрешения ключей и алиасов запрещены; входной объект не изменяется.
 */
export function preparePlanFields(
  fields: Readonly<Partial<WorkPlanFields>>,
  targets: readonly EntityIdentity[],
): Partial<WorkPlanFields> {
  if (fields.scope === undefined) {
    return fields;
  }
  const scope = fields.scope.map((entry, index) => {
    const target = targets[index];
    if (target === undefined || target.kind !== entry.kind) {
      throw new RelayError("NOT_FOUND", planningMessages.missingScope, 3, { ref: entry.id });
    }
    return { kind: entry.kind, id: target.id };
  });
  if (new Set(scope.map((entry) => entry.id)).size !== scope.length) {
    invalid(planningMessages.duplicateScope);
  }
  return { ...fields, scope };
}

/**
 * Дополняет проверенные поля нового плана начальными значениями.
 * Заголовок обязателен; план создаётся черновиком без этапов и временных отметок.
 */
export function newPlanData(
  fields: Readonly<Partial<WorkPlanFields>>,
  projectId: string,
): WorkPlanData {
  if (fields.title === undefined) {
    invalid(planningMessages.missingPlanTitle);
  }
  return {
    projectId,
    summary: "",
    goal: "",
    rationale: "",
    boundaries: "",
    expectedResult: "",
    participants: [],
    scope: [],
    stages: [],
    result: "",
    status: "draft",
    startedAt: null,
    closedAt: null,
    ...fields,
    title: fields.title,
  };
}

/**
 * Разрешает состав релиза в постоянные ID в исходном порядке.
 * Отменённый план разрешён только среди сохраняемых прежних включений.
 * Пустой набор previous при перепланировании намеренно проверяет весь состав как новый.
 */
export function resolveReleasePlans(
  plans: readonly WorkPlanRecord[],
  previous: ReadonlySet<string> = new Set(),
): string[] {
  const ids = plans.map((plan) => {
    if (plan.data.status === "cancelled" && !previous.has(plan.id)) {
      throw new RelayError("INVALID_PLAN", planningMessages.cancelledReleasePlan, 4, {
        id: plan.id,
      });
    }
    return plan.id;
  });
  if (new Set(ids).size !== ids.length) {
    invalid(planningMessages.duplicateReleasePlans);
  }
  return ids;
}

/**
 * Проверяет содержание релиза и разрешает только явно переданный состав.
 * Прежние ID разрешают сохранение уже включённого отменённого плана при редактировании.
 */
export function prepareReleaseFields(
  fields: Readonly<Partial<ReleaseFields>>,
  plans: readonly WorkPlanRecord[],
  previous: ReadonlySet<string> = new Set(),
): Partial<ReleaseFields> {
  if (fields.planIds === undefined) {
    return fields;
  }
  return {
    ...fields,
    planIds: resolveReleasePlans(plans, previous),
  };
}

/**
 * Дополняет проверенные поля нового релиза состоянием planned без факта выпуска.
 * Заголовок, версия и состав обязательны; ссылками и непустотой состава владеет подготовка полей.
 */
export function newReleaseData(
  fields: Readonly<Partial<ReleaseFields>>,
  projectId: string,
): ReleaseData {
  if (fields.title === undefined || fields.version === undefined || fields.planIds === undefined) {
    invalid(planningMessages.missingReleaseFields);
  }
  return {
    projectId,
    summary: "",
    description: "",
    plannedFor: "",
    status: "planned",
    releasedAt: null,
    releasedBy: null,
    ...fields,
    title: fields.title,
    version: fields.version,
    planIds: fields.planIds,
  };
}
