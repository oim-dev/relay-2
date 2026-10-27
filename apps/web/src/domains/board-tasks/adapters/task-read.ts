import type { TaskRecord, TaskView } from "@relay/contracts";
import { relayClient, RelayApiError } from "infra/tasks-api";
import { readEntity } from "domains/relay-data";
import type { TaskSummary } from "../types/board-tasks.type";

/**
 * Сверяет поколение до и после составного чтения. Не возвращает смешанный снимок.
 */
export async function taskSnapshot<T>(
  project: string,
  read: () => Promise<T>,
  version?: string,
): Promise<{ value: T; generation: number }> {
  const start = (await relayClient.read(project, "projectStatus", {})).data.generation;
  if (version !== undefined && String(start) !== version)
    throw new RelayApiError(
      { code: "PAGE_CHANGED", message: "Данные изменились, перечитайте список" },
      409,
    );
  const value = await read();
  const end = (await relayClient.read(project, "projectStatus", {})).data.generation;
  if (start !== end)
    throw new RelayApiError(
      { code: "PAGE_CHANGED", message: "Данные изменились, перечитайте список" },
      409,
    );
  return { value, generation: start };
}

/**
 * Читает карточку задачи, сохраняя связь kind/data.
 */
export async function taskRecord(project: string, ref: string): Promise<TaskRecord> {
  const record = await readEntity(project, ref);
  if (record.kind !== "task") throw new Error("Выбранная сущность не является задачей");
  return record;
}

/**
 * Адаптирует компактную карточку Core без дополнительных запросов и расчёта графа.
 */
export function taskView(record: TaskView): TaskSummary {
  return {
    id: record.id,
    key: record.key,
    revision: record.revision,
    boardId: record.boardId,
    boardSlug: record.boardSlug,
    title: record.title,
    column: record.column,
    productLinks: [...record.targets],
    parentId: record.parentId,
    dependencies: [...record.dependencies],
    related: [...record.related],
    blockers: record.progress.blockers,
    blocked: record.progress.blockers.length > 0,
    canComplete: record.progress.canComplete,
    acceptance: record.acceptance,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    createdBy: record.createdBy,
    updatedBy: record.updatedBy,
  };
}
