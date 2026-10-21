import type { TaskColumn, TaskRecord } from "@relay/contracts";
import { taskGraphNode } from "./task-data";
import { TaskGraph } from "./task-graph";

/** Разрешённые ссылки и проверенные значения фильтров одного снимка. */
export interface TaskSelection {
  boardId: string | undefined;
  column: TaskColumn | undefined;
  parentId: string | null | undefined;
  completion: "finished" | "unfinished" | undefined;
  searchIn: "title" | "all";
  query: string;
  readiness: "ready" | "blocked" | undefined;
  targetIds: ReadonlySet<string> | undefined;
}

/** Вычисляемые фильтры требуют весь набор; граф строится только для readiness. */
export function selectTaskRecords(records: TaskRecord[], selection: TaskSelection): TaskRecord[] {
  const graph =
    selection.readiness === undefined ? undefined : new TaskGraph(records.map(taskGraphNode));
  const targetIds = selection.targetIds;
  return records.filter((record) => {
    const data = record.data;
    if (selection.boardId !== undefined && data.boardId !== selection.boardId) return false;
    if (selection.column !== undefined && data.column !== selection.column) return false;
    if (selection.parentId !== undefined && data.parentId !== selection.parentId) return false;
    const finished = data.column === "done" || data.column === "cancelled";
    if (selection.completion !== undefined && finished !== (selection.completion === "finished"))
      return false;
    if (targetIds && !data.targets.some((id) => targetIds.has(id))) return false;
    if (
      selection.query &&
      ![
        record.id,
        record.key,
        data.title,
        ...(selection.searchIn === "all" ? [data.description] : []),
      ].some((value) => value.toLocaleLowerCase().includes(selection.query))
    )
      return false;
    if (selection.readiness) {
      const blocked = graph!.progress(record.id).blockers.length > 0;
      if (selection.readiness === "blocked" ? !blocked : blocked || data.column !== "ready")
        return false;
    }
    return true;
  });
}
