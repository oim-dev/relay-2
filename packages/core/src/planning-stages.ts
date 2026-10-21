/** Чистые изменения упорядоченных этапов; ревизией и записью владеет сценарий плана. */
import { RelayError, type PlanStage, type StageChange } from "@relay/contracts";
import { stageIndex } from "./planning-data";
import { invalid } from "./planning-input";

function beforeIndex(stages: readonly PlanStage[], before: string | null): number {
  return before === null ? stages.length : stageIndex(stages, before);
}

export function changeStages(current: readonly PlanStage[], change: StageChange): PlanStage[] {
  const stages = [...current];
  if (change.action === "create") {
    if (stages.length >= 200) invalid("В плане допускается не более 200 этапов.");
    stages.splice(beforeIndex(stages, change.before), 0, {
      id: crypto.randomUUID(),
      ...change.fields,
      taskIds: [],
    });
    return stages;
  }
  const index = stageIndex(stages, change.stageId);
  const stage = stages[index]!;
  if (change.action === "update") stages[index] = { ...stage, ...change.fields };
  else if (change.action === "remove") {
    if (stage.taskIds.length)
      throw new RelayError("STAGE_NOT_EMPTY", "Удалить можно только пустой этап.", 4);
    stages.splice(index, 1);
  } else if ("direction" in change.destination) {
    const destination = index + (change.destination.direction === "up" ? -1 : 1);
    if (destination < 0 || destination >= stages.length) return stages;
    stages.splice(index, 1);
    stages.splice(destination, 0, stage);
  } else {
    if (change.destination.before === stage.id) return stages;
    stages.splice(index, 1);
    stages.splice(beforeIndex(stages, change.destination.before), 0, stage);
  }
  return stages;
}
