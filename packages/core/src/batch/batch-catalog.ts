import type { BatchOperationDescription } from "@relay/contracts";
import { knowledgeBatchActions } from "./batch-knowledge";
import { taskBatchActions } from "./batch-tasks";
import { planningBatchActions } from "./batch-planning";
import { historyBatchActions } from "./batch-history";
import type { BatchAction } from "./batch.types";
import type { BatchStepContext } from "./batch-context";

const actions = [
  ...knowledgeBatchActions(),
  ...taskBatchActions(),
  ...planningBatchActions(),
  ...historyBatchActions(),
];

/**
 * Полный опубликованный каталог локальных предметных действий; построение не открывает проект.
 */
export const BATCH_OPERATIONS: readonly BatchOperationDescription[] = actions.map(
  (action) => action.description,
);

/**
 * Единственный реестр исполнения тех же действий, которые доступны в публичном каталоге.
 */
export const batchActions: ReadonlyMap<string, BatchAction<BatchStepContext>> = new Map(
  actions.map((action) => [action.description.op, action]),
);
