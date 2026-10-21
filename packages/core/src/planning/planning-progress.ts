/**
 * Чистая агрегация готовности: граф задач вычисляется вызывающим сценарием один раз.
 * Состав и прогресс задач должны принадлежать одному снимку; записи здесь не читаются и не меняются.
 */
import {
  RelayError,
  type WorkPlanRecord,
  type PlanProgress,
  type ReleaseProgress,
  type ProgressCounts,
  type PlanStage,
  type TaskProgress,
} from "@relay/contracts";
import { planningMessages } from "./planning.messages";

/**
 * Рассчитывает целый процент выполнения с округлением вниз; пустой состав имеет нулевой процент.
 */
function counts(total: number, completed: number): ProgressCounts {
  return { total, completed, percent: total ? Math.floor((completed * 100) / total) : 0 };
}

/**
 * Собирает уникальные ID задач в порядке первого включения для одного общего расчёта графа.
 */
export function planTaskIds(plans: readonly WorkPlanRecord[]): string[] {
  return [...new Set(plans.flatMap((plan) => plan.data.stages.flatMap((stage) => stage.taskIds)))];
}

/**
 * Рассчитывает готовность этапа по фактическому выполнению его явного состава.
 * Пустой этап не выполнен; отсутствие прогресса включённой задачи возвращает NOT_FOUND.
 */
function stageProgress(
  stage: Readonly<PlanStage>,
  tasks: ReadonlyMap<string, TaskProgress>,
): PlanProgress["stages"][number] {
  let completed = 0;
  const blockers = new Set<string>();
  for (const taskId of stage.taskIds) {
    const progress = tasks.get(taskId);
    if (progress === undefined) {
      throw new RelayError("NOT_FOUND", planningMessages.missingTaskProgress, 3, { taskId });
    }
    if (progress.completed) {
      completed += 1;
    } else {
      blockers.add(taskId);
      for (const blocker of progress.blockers) {
        blockers.add(blocker);
      }
    }
  }
  return {
    id: stage.id,
    completed: stage.taskIds.length > 0 && completed === stage.taskIds.length,
    counts: counts(stage.taskIds.length, completed),
    blockers: [...blockers],
  };
}

/**
 * Агрегирует фактическую готовность плана независимо от его сохранённого статуса.
 * Нужен непустой выполненный состав; пустой этап не блокирует остальные задачи.
 * Для пустого плана блокирующим ID служит сам план.
 */
export function planProgress(
  plan: Readonly<WorkPlanRecord>,
  tasks: ReadonlyMap<string, TaskProgress>,
): PlanProgress {
  const stages = plan.data.stages.map((stage) => stageProgress(stage, tasks));
  const total = stages.reduce((sum, stage) => sum + stage.counts.total, 0);
  const done = stages.reduce((sum, stage) => sum + stage.counts.completed, 0);
  // Пустой этап не готов, но не блокирует непустой фактически выполненный план.
  const completed = total > 0 && done === total;
  return {
    completed,
    canComplete: completed,
    counts: counts(total, done),
    stages,
    blockers: total ? [...new Set(stages.flatMap((stage) => stage.blockers))] : [plan.id],
  };
}

/**
 * Соединяет явно завершённый статус плана с актуальным выполнением его задач для релиза.
 */
function releasePlanProgress(
  plan: Readonly<WorkPlanRecord>,
  tasks: ReadonlyMap<string, TaskProgress>,
): ReleaseProgress["plans"][number] {
  const progress = planProgress(plan, tasks);
  const completed = plan.data.status === "completed" && progress.completed;
  return {
    id: plan.id,
    status: plan.data.status,
    completed,
    blockers: completed ? [] : [...new Set([plan.id, ...progress.blockers])],
  };
}

/**
 * Рассчитывает готовность непустого состава релиза на общей карте прогресса задач.
 * Каждый план должен быть явно завершён и фактически выполнен сейчас; выпуск не замораживает расчёт.
 */
export function releaseProgress(
  records: readonly WorkPlanRecord[],
  tasks: ReadonlyMap<string, TaskProgress>,
): ReleaseProgress {
  const plans = records.map((plan) => releasePlanProgress(plan, tasks));
  const done = plans.filter((plan) => plan.completed).length;
  const completed = plans.length > 0 && done === plans.length;
  // Статус выпущенного релиза не является снимком готовности связанных задач.
  return {
    completed,
    canRelease: completed,
    counts: counts(plans.length, done),
    plans,
    blockers: [...new Set(plans.flatMap((plan) => plan.blockers))],
  };
}
