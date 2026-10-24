import type {
  EntityRecord,
  PlanTransition,
  ReleaseRecord,
  ReleaseTransition,
  TaskProgress,
  WorkPlanRecord,
  WriteOptions,
} from "@relay/contracts";
import type { TaskGraphCache } from "../tasks/task-command-graph";
import { calculatePlanPatch, calculateReleasePatch } from "./planning-command-calculate";
import { planTaskIds } from "./planning-progress";
import { assertPlanningWritable } from "./planning-rules";
import type { PlanningDelta } from "./planning-command.types";

/**
 * Использует один общий граф данного логического состояния и проверяет все ID состава.
 */
function planningTaskProgress(
  plans: readonly WorkPlanRecord[],
  records: readonly EntityRecord[],
  cache: TaskGraphCache,
): ReadonlyMap<string, TaskProgress> {
  const ids = planTaskIds(plans);
  if (ids.length === 0) {
    return new Map();
  }
  const graph = cache.get(records);
  return new Map(ids.map((id) => [id, graph.progress(id)]));
}

/**
 * Рассчитывает lifecycle patch плана; допустимость ребра и готовность проверяет общий validator.
 * Cancel/start не строят граф, complete получает заранее загруженную узкую проекцию.
 */
export function calculatePlanTransition(
  current: WorkPlanRecord,
  change: PlanTransition,
  records: readonly EntityRecord[],
  cache: TaskGraphCache,
  write: Readonly<WriteOptions>,
  timestamp: string,
): PlanningDelta<WorkPlanRecord> {
  assertPlanningWritable(current, write);
  const fields =
    change.action === "start"
      ? { status: "active" as const, startedAt: timestamp }
      : {
          status: change.action === "complete" ? ("completed" as const) : ("cancelled" as const),
          result: change.result,
          closedAt: timestamp,
        };
  return calculatePlanPatch(current, fields, write, timestamp, {
    actor: write.actor,
    operation: `plan.${change.action}`,
    ...(change.action === "complete"
      ? { taskProgress: planningTaskProgress([current], records, cache) }
      : {}),
  });
}

/**
 * Рассчитывает replan/cancel/publish релиза без записи планов состава. Повтор plan/cancel
 * сохраняет revision после CAS; публикация проверяет актуальную готовность одним графом.
 */
export function calculateReleaseTransition(
  current: ReleaseRecord,
  action: ReleaseTransition,
  plans: readonly WorkPlanRecord[],
  records: readonly EntityRecord[],
  cache: TaskGraphCache,
  write: Readonly<WriteOptions>,
  timestamp: string,
): PlanningDelta<ReleaseRecord> {
  assertPlanningWritable(current, write);
  const fields =
    action === "publish"
      ? { status: "released" as const, releasedAt: timestamp, releasedBy: write.actor }
      : { status: action === "plan" ? ("planned" as const) : ("cancelled" as const) };
  return calculateReleasePatch(current, fields, write, timestamp, {
    actor: write.actor,
    operation: `release.${action}`,
    plans,
    ...(action === "publish" && current.data.status === "planned"
      ? { taskProgress: planningTaskProgress(plans, records, cache) }
      : {}),
  });
}
