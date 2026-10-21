/**
 * Расчёт изменений упорядоченных этапов и включений без изменения переданного состояния.
 * Ревизиями, проверкой конфликтов между планами и записью владеет сценарий сервиса.
 */
import {
  RelayError,
  type PlanStage,
  type StageChange,
  type WorkPlanRecord,
} from "@relay/contracts";
import { requireStage, stageIndex } from "./planning-rules";
import { invalid } from "./planning-validation";
import { planningLimits } from "./planning.constants";
import { planningMessages } from "./planning.messages";
import type { StageTaskAction, TransferredPlanStages } from "./planning.types";

/**
 * Определяет позицию перед существующим этапом; null задаёт конец списка.
 */
function beforeIndex(stages: readonly PlanStage[], before: string | null): number {
  return before === null ? stages.length : stageIndex(stages, before);
}

/**
 * Рассчитывает создание, изменение, удаление или перемещение этапа без записи.
 * Создание выдаёт новый ID; удалить можно только пустой этап. Выход за край и перенос
 * перед самим собой сохраняют состав; проверку исходной ревизии выполняет сервис до вызова.
 */
export function changeStages(
  current: readonly PlanStage[],
  change: Readonly<StageChange>,
): PlanStage[] {
  const stages = [...current];
  if (change.action === "create") {
    if (stages.length >= planningLimits.stages) {
      invalid(planningMessages.stageLimit(planningLimits.stages));
    }
    stages.splice(beforeIndex(stages, change.before), 0, {
      id: crypto.randomUUID(),
      ...change.fields,
      taskIds: [],
    });
    return stages;
  }
  const stage = requireStage(stages, change.stageId);
  const index = stages.indexOf(stage);
  if (change.action === "update") {
    stages[index] = { ...stage, ...change.fields };
  } else if (change.action === "remove") {
    if (stage.taskIds.length) {
      throw new RelayError("STAGE_NOT_EMPTY", planningMessages.stageNotEmpty, 4);
    }
    stages.splice(index, 1);
  } else if ("direction" in change.destination) {
    const destination = index + (change.destination.direction === "up" ? -1 : 1);
    if (destination < 0 || destination >= stages.length) {
      return stages;
    }
    stages.splice(index, 1);
    stages.splice(destination, 0, stage);
  } else {
    if (change.destination.before === stage.id) {
      return stages;
    }
    stages.splice(index, 1);
    stages.splice(beforeIndex(stages, change.destination.before), 0, stage);
  }
  return stages;
}

/**
 * Рассчитывает идемпотентное включение или исключение задачи в существующем этапе.
 * undefined обозначает no-op; ограничение размера проверяется только для нового включения.
 * Доступность задачи в остальных открытых планах проверяет сервис до вызова.
 */
export function changeStageTask(
  stages: readonly PlanStage[],
  stage: Readonly<PlanStage>,
  taskId: string,
  action: StageTaskAction,
): PlanStage[] | undefined {
  const included = stage.taskIds.includes(taskId);
  if (action === "remove") {
    if (!included) {
      return undefined;
    }
    return replaceStageTasks(
      stages,
      stage.id,
      stage.taskIds.filter((id) => id !== taskId),
    );
  }
  if (included) {
    return undefined;
  }
  assertStageHasCapacity(stage);
  return replaceStageTasks(stages, stage.id, [...stage.taskIds, taskId]);
}

/**
 * Рассчитывает составы переноса после проверки исходного включения и обеих ревизий.
 * Перенос внутри одного плана объединяет исключение и включение в одном массиве;
 * повтор на том же этапе возвращает undefined. Переданные планы и этапы не изменяются.
 */
export function transferStageTask(
  source: Readonly<WorkPlanRecord>,
  target: Readonly<WorkPlanRecord>,
  sourceStage: Readonly<PlanStage>,
  targetStage: Readonly<PlanStage>,
  taskId: string,
): TransferredPlanStages | undefined {
  if (source.id === target.id && sourceStage.id === targetStage.id) {
    return undefined;
  }
  assertStageHasCapacity(targetStage);
  const sourceStages = replaceStageTasks(
    source.data.stages,
    sourceStage.id,
    sourceStage.taskIds.filter((id) => id !== taskId),
  );
  const targetStages = replaceStageTasks(
    source.id === target.id ? sourceStages : target.data.stages,
    targetStage.id,
    [...targetStage.taskIds, taskId],
  );
  if (source.id === target.id) {
    return { source: targetStages, target: targetStages };
  }
  return { source: sourceStages, target: targetStages };
}

/**
 * Проверяет свободное место для нового явного включения задачи.
 */
function assertStageHasCapacity(stage: Readonly<PlanStage>): void {
  if (stage.taskIds.length >= planningLimits.stageTasks) {
    invalid(planningMessages.stageTaskLimit(planningLimits.stageTasks));
  }
}

/**
 * Заменяет состав известного этапа копированием; порядок остальных этапов и задач сохраняется.
 */
function replaceStageTasks(
  stages: readonly PlanStage[],
  stageId: string,
  taskIds: readonly string[],
): PlanStage[] {
  return stages.map((stage) =>
    stage.id === stageId ? { ...stage, taskIds: [...taskIds] } : stage,
  );
}
