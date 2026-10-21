/**
 * Подготовка содержания планирования: разрешение ссылок и начальное состояние записей.
 * Чтения выполняются внутри транзакции вызывающего сервиса; этот модуль ничего не сохраняет.
 */
import {
  RelayError,
  type ReleaseData,
  type ReleaseFields,
  type WorkPlanData,
  type WorkPlanFields,
} from "@relay/contracts";
import type { EntityService } from "../entities/entities";
import { decodePlan } from "./planning-data";
import { parsePlanFields, parseReleaseFields } from "./planning-input";
import { invalid, reference } from "./planning-validation";
import { planningMessages } from "./planning.messages";

/**
 * Проверяет поля плана и разрешает области воздействия в постоянные ID.
 * Повторы после разрешения ключей и алиасов запрещены; входной объект не изменяется.
 */
export function preparePlanFields(
  entities: EntityService,
  input: unknown,
): Partial<WorkPlanFields> {
  const fields = parsePlanFields(input);
  if (fields.scope === undefined) {
    return fields;
  }
  const scope = fields.scope.map((entry) => ({
    kind: entry.kind,
    id: entities.get(entry.id, entry.kind).id,
  }));
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
  entities: EntityService,
  projectId: string,
  refs: readonly string[],
  previous: ReadonlySet<string> = new Set(),
): string[] {
  const ids = refs.map((ref) => {
    const plan = decodePlan(entities.get(reference(ref, "ref"), "work-plan"), projectId);
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
  entities: EntityService,
  projectId: string,
  input: unknown,
  previous: ReadonlySet<string> = new Set(),
): Partial<ReleaseFields> {
  const fields = parseReleaseFields(input);
  if (fields.planIds === undefined) {
    return fields;
  }
  return {
    ...fields,
    planIds: resolveReleasePlans(entities, projectId, fields.planIds, previous),
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
