import { RelayError, type TaskColumn, type TaskProgress } from "@relay/contracts";
import type { TaskGraphEntry, TaskGraphNode } from "./task-graph.types";
import { taskMessages } from "./task-messages";

export type { TaskGraphNode } from "./task-graph.types";

/**
 * Чистый расчёт одного снимка: родители ожидают детей, задачи — свои зависимости.
 * Принимает уже декодированные поля; отвергает циклы и отсутствующие обязательства.
 * Не читает БД и не изменяет входные данные.
 */
export class TaskGraph {
  /* Исходные проекции, индексированные постоянными ID задач. */
  private readonly nodes = new Map<string, TaskGraphNode>();
  /* Полностью рассчитанный прогресс; наружу возвращаются копии изменяемых массивов. */
  private readonly results = new Map<string, TaskProgress>();

  /**
   * Строит объединённый граф родительства и зависимостей и рассчитывает его за O(V + E).
   * Совпавшие ребёнок и явная зависимость образуют одно обязательство, сохраняя порядок связей.
   */
  constructor(nodes: readonly TaskGraphNode[]) {
    const entries = new Map<string, TaskGraphEntry>();
    for (const node of nodes) {
      this.nodes.set(node.id, node);
      entries.set(node.id, {
        node,
        obligations: new Set(),
        dependants: new Set(),
        remaining: 0,
        completed: false,
      });
    }
    for (const node of nodes) {
      for (const dependency of node.dependencies) {
        this.link(entries, node.id, dependency);
      }
      if (node.parentId !== null) {
        this.link(entries, node.parentId, node.id);
      }
    }
    this.calculateProgress(entries);
  }

  /**
   * Возвращает сохранённую колонку задачи; отсутствующий ID приводит к NOT_FOUND.
   */
  column(id: string): TaskColumn {
    const node = this.nodes.get(id);
    if (node === undefined) {
      throw new RelayError("NOT_FOUND", taskMessages.taskNotFound, 3, { id });
    }
    return node.column;
  }

  /**
   * Возвращает независимую копию прогресса; отсутствующий ID приводит к NOT_FOUND.
   */
  progress(id: string): TaskProgress {
    const result = this.results.get(id);
    if (result === undefined) {
      throw new RelayError("NOT_FOUND", taskMessages.taskNotFound, 3, { id });
    }
    return { ...result, blockers: [...result.blockers] };
  }

  /**
   * Добавляет прямое обязательство в оба индекса, отвергая самоссылку и отсутствующий узел.
   */
  private link(entries: ReadonlyMap<string, TaskGraphEntry>, source: string, target: string): void {
    if (source === target) {
      throw new RelayError("TASK_CYCLE", taskMessages.selfReference, 2, { id: source });
    }
    const dependant = entries.get(source);
    const obligation = entries.get(target);
    if (dependant === undefined || obligation === undefined) {
      throw new RelayError("BROKEN_REFERENCE", taskMessages.brokenObligation, 1, {
        source,
        target,
      });
    }
    dependant.obligations.add(obligation);
    obligation.dependants.add(dependant);
  }

  /**
   * Обходит граф от листьев без рекурсии; посещает узел только после расчёта всех обязательств.
   * Непосещённый остаток означает цикл. Начальный completed не читается до посещения узла.
   * Индекс смежности не сохраняется в экземпляре: после расчёта нужны только проекции и результаты.
   */
  private calculateProgress(entries: ReadonlyMap<string, TaskGraphEntry>): void {
    const queue: TaskGraphEntry[] = [];
    for (const entry of entries.values()) {
      entry.remaining = entry.obligations.size;
      if (entry.remaining === 0) {
        queue.push(entry);
      }
    }
    // Итератор массива посещает добавляемые узлы и не зависит от глубины декомпозиции.
    for (const entry of queue) {
      const blockers = [...entry.obligations]
        .filter((obligation) => !obligation.completed)
        .map((obligation) => obligation.node.id);
      const canComplete =
        blockers.length === 0 && entry.node.acceptanceCriteria.every((item) => item.completed);
      entry.completed = entry.node.column === "done" && canComplete;
      this.results.set(entry.node.id, { completed: entry.completed, canComplete, blockers });
      for (const dependant of entry.dependants) {
        dependant.remaining -= 1;
        if (dependant.remaining === 0) {
          queue.push(dependant);
        }
      }
    }
    if (queue.length !== entries.size) {
      throw new RelayError("TASK_CYCLE", taskMessages.cycle, 2);
    }
  }
}
