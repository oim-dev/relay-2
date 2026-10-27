import {
  RelayError,
  type TaskCandidatePage,
  type TaskView,
  type TaskViewPage,
  type TaskViewTarget,
  type TaskViewCounts,
} from "@relay/contracts";
import type { ProjectStore } from "@relay/storage";
import { EntityService } from "../entities/entities";
import { pageEntities } from "../entities/entity-page";
import { decodeKnowledge } from "../knowledge/knowledge-data";
import { taskGraphNode, taskRecord, taskViewRecord } from "./task-data";
import type { TaskViewRecord } from "./task-data.types";
import { TaskGraph } from "./task-graph";
import { selectTaskRecords } from "./task-list";
import { TaskReferences } from "./task-references";
import { parseTaskViewInput } from "./task-views-input";
import { taskCandidateSelection } from "./task-candidates";
import type { TaskViewInput } from "./task-views.types";
import { taskViewMessages } from "./task-views.messages";

/**
 * Считает выбранные задачи через уже построенный граф; цели не задают готовность продукта.
 */
function countTasks(records: readonly TaskViewRecord[], graph: TaskGraph): TaskViewCounts {
  const columns = { inbox: 0, ready: 0, "in-progress": 0, review: 0, done: 0, cancelled: 0 };
  let completed = 0;
  let blocked = 0;
  let targetedTotal = 0;
  let targetedCompleted = 0;
  for (const record of records) {
    const progress = graph.progress(record.id);
    columns[record.data.column] += 1;
    completed += Number(progress.completed);
    blocked += Number(progress.blockers.length > 0);
    if (record.data.targets.length > 0) {
      targetedTotal += 1;
      targetedCompleted += Number(progress.completed);
    }
  }
  return {
    total: records.length,
    completed,
    allCompleted: records.length > 0 && completed === records.length,
    blocked,
    targetedTotal,
    targetedCompleted,
    columns,
  };
}

/**
 * Читает реквизиты только адресов окна двумя пакетными запросами, без HTTP/SQL N+1.
 * Полные тела задач, тексты критериев и журналы в результат не попадают.
 */
function taskWindow(
  db: ProjectStore,
  records: readonly TaskViewRecord[],
  graph: TaskGraph,
): TaskView[] {
  const boardIds = [...new Set(records.map((record) => record.data.boardId))];
  const boards = new Map(
    db.getMany(boardIds, "board").map((record) => {
      const board = decodeKnowledge(record, "board");
      return [board.id, board.data.slug] as const;
    }),
  );
  const targetIds = [...new Set(records.flatMap((record) => record.data.targets))];
  const targets = new Map<string, TaskViewTarget>();
  for (const target of db.getManyIdentities(targetIds)) {
    if (
      target.kind !== "feature" &&
      target.kind !== "scenario" &&
      target.kind !== "implementation"
    ) {
      throw new RelayError("BROKEN_REFERENCE", taskViewMessages.missingTarget, 1, {
        id: target.id,
      });
    }
    targets.set(target.id, { id: target.id, kind: target.kind });
  }
  return records.map((record) => {
    const boardSlug = boards.get(record.data.boardId);
    if (boardSlug === undefined) {
      throw new RelayError("BROKEN_REFERENCE", taskViewMessages.missingBoard, 1, {
        id: record.data.boardId,
      });
    }
    return {
      id: record.id,
      key: record.key,
      revision: record.revision,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      createdBy: record.createdBy,
      updatedBy: record.updatedBy,
      title: record.data.title,
      boardId: record.data.boardId,
      boardSlug,
      column: record.data.column,
      parentId: record.data.parentId,
      dependencies: record.data.dependencies,
      related: record.data.related,
      targets: record.data.targets.map((id) => {
        const target = targets.get(id);
        if (target === undefined) {
          throw new RelayError("BROKEN_REFERENCE", taskViewMessages.missingTarget, 1, { id });
        }
        return target;
      }),
      acceptance: {
        total: record.data.acceptanceCriteria.length,
        completed: record.data.acceptanceCriteria.filter((item) => item.completed).length,
      },
      progress: graph.progress(record.id),
    };
  });
}

/**
 * Компактные составные чтения текущих задач. Никаких новых правил записи или готовности продукта.
 * Граф строится ровно один раз на snapshot и используется фильтром, сводкой и окном.
 */
export class TaskViewsService {
  /**
   * Заимствует открытое соединение; не закрывает его и не кеширует результаты между запросами.
   */
  constructor(
    /* Соединение локального проекта, принадлежащее вызывающему. */ private readonly db: ProjectStore,
  ) {}

  /**
   * Возвращает окно и сводку одного поколения. Продолжение без поколения или с устаревшим
   * поколением отвергается. Без поиска по описанию читается metadata без тел и журналов;
   * явный полнотекстовый поиск пока требует один полный scan. Результат ограничен limit.
   */
  page(query: unknown = {}): TaskViewPage {
    const result = this.read(parseTaskViewInput(query, false), false);
    return { ...result, items: result.items.map(({ assignment: _assignment, ...item }) => item) };
  }

  /**
   * Фильтрует открытые включения до окна через один индекс планов того же снимка.
   * Доступность означает отсутствие чужого открытого включения, не новое условие записи.
   */
  candidates(query: unknown = {}): TaskCandidatePage {
    return this.read(parseTaskViewInput(query, true), true);
  }

  /**
   * Удерживает один снимок поколения, фильтров, графа, включений, totals и карточек окна.
   */
  private read(input: TaskViewInput, candidates: boolean): TaskCandidatePage {
    return this.db.snapshot(() => {
      const generation = this.db.getGeneration();
      if (input.generation !== undefined && input.generation !== generation) {
        throw new RelayError("PAGE_CHANGED", taskViewMessages.pageChanged, 4, {
          expected: input.generation,
          actual: generation,
        });
      }
      const entities = new EntityService(this.db);
      const references = new TaskReferences(this.db, entities);
      const nodes = this.db.listTaskGraph().map(taskGraphNode);
      const graph = new TaskGraph(nodes);
      let records: TaskViewRecord[];
      if (input.refs !== undefined) {
        const ids = [...new Set(input.refs.map((ref) => entities.resolve(ref, "task").id))];
        records = this.db.getMany(ids, "task").map(taskRecord);
      } else if (input.ref !== undefined) {
        records = [references.task(input.ref)];
      } else if (input.filters.query !== "" && input.filters.searchIn === "all") {
        records = this.db.list("task").map(taskRecord);
      } else {
        const graphNodes = new Map(nodes.map((node) => [node.id, node]));
        records = this.db
          .listGraphSources("relations")
          .filter((record) => record.kind === "task")
          .map((record) => {
            const node = graphNodes.get(record.id);
            if (node === undefined) {
              throw new RelayError("CORRUPT_DATA", taskViewMessages.missingGraphNode, 1, {
                id: record.id,
              });
            }
            return taskViewRecord(record, node);
          });
      }
      let selected = selectTaskRecords(records, references.selection(input.filters), graph);
      const membership = candidates ? taskCandidateSelection(this.db, input) : undefined;
      if (input.availableOnly && membership !== undefined) {
        selected = selected.filter((task) => {
          const assignment = membership.assignments.get(task.id);
          return (
            assignment === undefined ||
            (assignment.planId === membership.planId && assignment.stageId === membership.stageId)
          );
        });
      }
      const page = pageEntities(selected, input.page);
      const items = taskWindow(this.db, page.items, graph).map((item) => ({
        ...item,
        assignment: membership?.assignments.get(item.id) ?? null,
      }));
      const next = input.page.offset + items.length;
      return {
        items,
        total: selected.length,
        counts: countTasks(selected, graph),
        generation,
        nextOffset: next < selected.length ? next : null,
      };
    });
  }
}
