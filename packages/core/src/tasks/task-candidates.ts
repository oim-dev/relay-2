import { RelayError, type TaskViewAssignment } from "@relay/contracts";
import type { ProjectStore } from "@relay/storage";
import { EntityService } from "../entities/entities";
import { decodePlan } from "../planning/planning-data";
import { openPlan, requireStage } from "../planning/planning-rules";
import type { TaskCandidateSelection, TaskViewInput } from "./task-views.types";
import { taskViewMessages } from "./task-views.messages";

/**
 * Один раз читает планы и индексирует открытые включения в снимке вызывающего reader.
 * Повреждённое двойное включение не превращается в произвольно выбранный план.
 */
export function taskCandidateSelection(
  db: ProjectStore,
  input: TaskViewInput,
): TaskCandidateSelection {
  const plans = db.list("work-plan").map((record) => decodePlan(record, db.projectId));
  const assignments = new Map<string, TaskViewAssignment>();
  for (const plan of plans) {
    if (!openPlan(plan)) {
      continue;
    }
    for (const stage of plan.data.stages) {
      for (const task of stage.taskIds) {
        if (assignments.has(task)) {
          throw new RelayError("CORRUPT_DATA", taskViewMessages.duplicateMembership, 1, {
            id: task,
          });
        }
        assignments.set(task, {
          planId: plan.id,
          planKey: plan.key,
          stageId: stage.id,
          stageTitle: stage.title,
        });
      }
    }
  }
  let planId: string | undefined;
  if (input.plan !== undefined && input.stageId !== undefined) {
    const plan = decodePlan(new EntityService(db).get(input.plan, "work-plan"), db.projectId);
    requireStage(plan.data.stages, input.stageId);
    planId = plan.id;
  }
  return { assignments, planId, stageId: input.stageId };
}
