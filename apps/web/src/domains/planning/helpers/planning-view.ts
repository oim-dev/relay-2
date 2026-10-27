import type {
  WorkPlanRecord,
  PlanProgress,
  ProgressCounts,
  PlanStage as CoreStage,
} from "@relay/contracts";
import type { PlanningPlan, PlanSummary, PlanStage } from "../types/planning.type";
import { EMPTY_PLAN_SUMMARY } from "../config/planning.config";

/**
 * Адаптирует счётчики Core. Отсутствующие в новом API колоночные показатели остаются неизвестными.
 */
export function planningCountsView(
  counts: ProgressCounts,
  completed: boolean,
  blockers: readonly string[],
): PlanSummary {
  return {
    total: counts.total,
    done: counts.completed,
    percent: counts.percent,
    completed,
    active: null,
    review: null,
    blocked: blockers.length,
  };
}

/**
 * Преобразует карточку и прогресс одного проверенного поколения в модель прежнего экрана.
 */
export function planningView(plan: WorkPlanRecord, progress: PlanProgress): PlanningPlan {
  const next = progress.stages.find((stage) => !stage.completed);
  return {
    id: plan.id,
    key: plan.key,
    revision: plan.revision,
    ...plan.data,
    scope: plan.data.scope.map((ref) => `${ref.kind}:${ref.id}`),
    scopeLabels: plan.data.scope.map((ref) => `${ref.kind}:${ref.id}`),
    updatedAt: plan.updatedAt,
    stageCount: plan.data.stages.length,
    stagePreview: progress.stages.map((stage) => ({ id: stage.id, completed: stage.completed })),
    nextStageTitle: plan.data.stages.find((stage) => stage.id === next?.id)?.title ?? null,
    progress: planningCountsView(progress.counts, progress.completed, progress.blockers),
    isReady: progress.canComplete,
  };
}

/**
 * Присоединяет к этапу только рассчитанную Core готовность.
 */
export function stageView(stage: CoreStage, progress: PlanProgress["stages"][number]): PlanStage {
  return {
    ...stage,
    progress: planningCountsView(progress.counts, progress.completed, progress.blockers),
  };
}

/**
 * Создаёт только ввод формы; постоянный ID и ключ назначает Core.
 */
export function createPlanDraft(): PlanningPlan {
  return {
    id: "new",
    key: "Новый план",
    revision: 0,
    title: "",
    summary: "",
    goal: "",
    rationale: "",
    boundaries: "",
    expectedResult: "",
    participants: [],
    status: "draft",
    scope: [],
    scopeLabels: [],
    updatedAt: new Date().toISOString(),
    result: "",
    stageCount: 0,
    stagePreview: [],
    nextStageTitle: null,
    progress: { ...EMPTY_PLAN_SUMMARY },
    isReady: false,
  };
}

/**
 * Возвращает серверный итог, независимо от количества раскрытых строк.
 */
export const getPlanSummary = (plan: PlanningPlan): PlanSummary => plan.progress;
