/** Чистая агрегация готовности: граф задач вычисляется вызывающим сценарием один раз. */
import {
  RelayError,
  type WorkPlanRecord,
  type PlanProgress,
  type ReleaseProgress,
  type ProgressCounts,
} from "@relay/contracts";
import type { TaskProgress } from "./tasks";

function counts(total: number, completed: number): ProgressCounts {
  return { total, completed, percent: total ? Math.floor((completed * 100) / total) : 0 };
}

export function planTaskIds(plans: readonly WorkPlanRecord[]): string[] {
  return [...new Set(plans.flatMap((plan) => plan.data.stages.flatMap((stage) => stage.taskIds)))];
}

export function planProgress(
  plan: WorkPlanRecord,
  tasks: ReadonlyMap<string, TaskProgress>,
): PlanProgress {
  const stages = plan.data.stages.map((stage) => {
    let completed = 0;
    const blockers = new Set<string>();
    for (const taskId of stage.taskIds) {
      const progress = tasks.get(taskId);
      if (!progress)
        throw new RelayError("NOT_FOUND", "Не найден прогресс включённой задачи.", 3, { taskId });
      if (progress.completed) completed += 1;
      else {
        blockers.add(taskId);
        for (const blocker of progress.blockers) blockers.add(blocker);
      }
    }
    return {
      id: stage.id,
      completed: stage.taskIds.length > 0 && completed === stage.taskIds.length,
      counts: counts(stage.taskIds.length, completed),
      blockers: [...blockers],
    };
  });
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

export function releaseProgress(
  records: readonly WorkPlanRecord[],
  tasks: ReadonlyMap<string, TaskProgress>,
): ReleaseProgress {
  const plans = records.map((plan) => {
    const progress = planProgress(plan, tasks);
    const completed = plan.data.status === "completed" && progress.completed;
    return {
      id: plan.id,
      status: plan.data.status,
      completed,
      blockers: completed ? [] : [...new Set([plan.id, ...progress.blockers])],
    };
  });
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
