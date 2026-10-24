import {
  ENTITY_KINDS,
  TASK_COLUMNS,
  type EntityKind,
  type ProjectEntity,
  type TaskColumn,
  type TaskRecord,
} from "@relay/contracts";
import type { ProjectStore } from "@relay/storage";
import { EntityReader } from "../projections/entity-reader";
import { taskGraphNode } from "../tasks/task-data";
import { TaskGraph } from "../tasks/task-graph";
import type { ProjectOverview, ProjectTaskOverview } from "./queries.types";

/**
 * Подсчитывает записи за один обход уже прочитанного состава, включая нули для пустых видов.
 */
function countEntityKinds(items: readonly ProjectEntity[]): Record<EntityKind, number> {
  const counts = new Map<EntityKind, number>();
  for (const item of items) {
    counts.set(item.kind, (counts.get(item.kind) ?? 0) + 1);
  }
  // fromEntries теряет объединение ключей; полный ENTITY_KINDS гарантирует каждый ключ результата.
  return Object.fromEntries(ENTITY_KINDS.map((kind) => [kind, counts.get(kind) ?? 0])) as Record<
    EntityKind,
    number
  >;
}

/**
 * Рассчитывает колонки и блокировки из одного полного набора проверенных задач.
 * Граф создаётся один раз без чтения БД; циклы и отсутствующие обязательства отклоняются.
 */
function summarizeTasks(tasks: readonly TaskRecord[]): ProjectTaskOverview {
  const graph = new TaskGraph(tasks.map(taskGraphNode));
  const columns = new Map<TaskColumn, number>();
  let blocked = 0;
  for (const task of tasks) {
    columns.set(task.data.column, (columns.get(task.data.column) ?? 0) + 1);
    if (graph.progress(task.id).blockers.length > 0) {
      blocked++;
    }
  }
  return {
    total: tasks.length,
    columns: Object.fromEntries(TASK_COLUMNS.map((column) => [column, columns.get(column) ?? 0])),
    blocked,
  };
}

/**
 * Строит полный обзор внутри снимка, которым владеет вызывающий QueryService.
 * Полный список читается один раз; проект, разделы, счётчики и граф используют загруженные карточки.
 * Повреждённые карточки и неверный граф отклоняются предметными декодерами без записи в БД.
 */
export function readProjectOverview(db: ProjectStore): ProjectOverview {
  const records = db.list();
  const reader = new EntityReader(
    db,
    records.find((item) => item.id === db.projectId && item.kind === "project") ?? null,
  );
  const items = records
    .map((item) => reader.decode(item))
    .sort((left, right) => left.key.localeCompare(right.key) || left.id.localeCompare(right.id));
  return {
    items,
    project: reader.project(),
    generation: db.getGeneration(),
    counts: countEntityKinds(items),
    tasks: summarizeTasks(items.filter((item) => item.kind === "task")),
  };
}
