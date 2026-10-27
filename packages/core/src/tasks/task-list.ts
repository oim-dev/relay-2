import type { TaskViewRecord } from "./task-data.types";
import { RelayError } from "@relay/contracts";
import { taskViewMessages } from "./task-views.messages";
import { taskGraphNode } from "./task-data";
import { TaskGraph } from "./task-graph";
import type { TaskSelection } from "./task-list.types";

export type { TaskSelection } from "./task-list.types";

/**
 * Проверяет фильтры сохранённого содержания без вычисления прогресса и без изменения записи.
 */
function matchesTaskSelection(record: TaskViewRecord, selection: TaskSelection): boolean {
  const data = record.data;
  if (selection.boardId !== undefined && data.boardId !== selection.boardId) {
    return false;
  }
  if (selection.column !== undefined && data.column !== selection.column) {
    return false;
  }
  if (selection.parentId !== undefined && data.parentId !== selection.parentId) {
    return false;
  }
  const finished = data.column === "done" || data.column === "cancelled";
  if (selection.completion !== undefined && finished !== (selection.completion === "finished")) {
    return false;
  }
  const targetIds = selection.targetIds;
  if (targetIds !== undefined && !data.targets.some((id) => targetIds.has(id))) {
    return false;
  }
  const searchValues = [record.id, record.key, data.title];
  if (selection.searchIn === "all" && selection.query !== "" && data.description === undefined) {
    throw new RelayError("INTERNAL_ERROR", taskViewMessages.missingSearchBody, 1, {
      id: record.id,
    });
  }
  if (selection.searchIn === "all" && data.description !== undefined) {
    searchValues.push(data.description);
  }
  if (
    selection.query &&
    !searchValues.some((value) => value.toLocaleLowerCase().includes(selection.query))
  ) {
    return false;
  }
  return true;
}

/**
 * Фильтрует полный набор одного снимка, сохраняя порядок входных записей.
 * Один граф строится только для readiness; невыполненные собственные критерии не блокируют старт.
 * Пагинация результата ограничивает выдачу, но не объём этого расчёта и исходного чтения.
 * suppliedGraph должен относиться к тому же снимку; составной reader передаёт его для переиспользования.
 */
export function selectTaskRecords<T extends TaskViewRecord>(
  records: readonly T[],
  selection: TaskSelection,
  suppliedGraph?: TaskGraph,
): T[] {
  const graph =
    selection.readiness === undefined
      ? undefined
      : (suppliedGraph ?? new TaskGraph(records.map(taskGraphNode)));
  return records.filter((record) => {
    if (!matchesTaskSelection(record, selection)) {
      return false;
    }
    if (graph === undefined) {
      return true;
    }
    const blocked = graph.progress(record.id).blockers.length > 0;
    if (selection.readiness === "blocked") {
      return blocked;
    }
    return !blocked && record.data.column === "ready";
  });
}
