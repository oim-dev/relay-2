import { RelayError, type TaskColumn, type TaskProgress } from "@relay/contracts";

/** Проверенные поля обязательств; тексты и журнал задачи не участвуют в расчёте. */
export interface TaskGraphNode {
  id: string;
  column: TaskColumn;
  parentId: string | null;
  dependencies: readonly string[];
  acceptanceCriteria: readonly { completed: boolean }[];
}

/**
 * Чистый расчёт одного снимка: родители ожидают детей, задачи — свои зависимости.
 * Принимает уже декодированные поля; отвергает циклы и отсутствующие обязательства.
 * Не читает БД и не изменяет входные данные.
 */
export class TaskGraph {
  private readonly nodes = new Map<string, TaskGraphNode>();
  private readonly results = new Map<string, TaskProgress>();

  constructor(nodes: readonly TaskGraphNode[]) {
    for (const node of nodes) this.nodes.set(node.id, node);
    const obligations = new Map<string, Set<string>>();
    const dependants = new Map<string, Set<string>>();
    for (const id of this.nodes.keys()) {
      obligations.set(id, new Set());
      dependants.set(id, new Set());
    }
    const link = (source: string, target: string) => {
      if (source === target) {
        throw new RelayError("TASK_CYCLE", "Самоссылка задачи запрещена", 2, { id: source });
      }
      if (!this.nodes.has(source) || !this.nodes.has(target)) {
        throw new RelayError(
          "BROKEN_REFERENCE",
          "В графе задач отсутствует обязательная задача",
          1,
          { source, target },
        );
      }
      obligations.get(source)!.add(target);
      dependants.get(target)!.add(source);
    };
    for (const node of nodes) {
      for (const dependency of node.dependencies) link(node.id, dependency);
      if (node.parentId !== null) link(node.parentId, node.id);
    }

    // Обход от листьев не зависит от глубины декомпозиции и не переполняет стек.
    const remaining = new Map([...obligations].map(([id, items]) => [id, items.size]));
    const queue = [...remaining].filter(([, count]) => count === 0).map(([id]) => id);
    for (let index = 0; index < queue.length; index++) {
      const id = queue[index]!;
      const node = this.nodes.get(id)!;
      const blockers = [...obligations.get(id)!].filter(
        (target) => !this.results.get(target)!.completed,
      );
      const canComplete =
        blockers.length === 0 && node.acceptanceCriteria.every((item) => item.completed);
      this.results.set(id, {
        completed: node.column === "done" && canComplete,
        canComplete,
        blockers,
      });
      for (const dependant of dependants.get(id)!) {
        const count = remaining.get(dependant)! - 1;
        remaining.set(dependant, count);
        if (count === 0) queue.push(dependant);
      }
    }
    if (queue.length !== this.nodes.size) {
      throw new RelayError(
        "TASK_CYCLE",
        "Обнаружен цикл родительства и обязательных зависимостей",
        2,
      );
    }
  }

  column(id: string): TaskColumn {
    const node = this.nodes.get(id);
    if (!node) throw new RelayError("NOT_FOUND", "Задача не найдена", 3, { id });
    return node.column;
  }

  progress(id: string): TaskProgress {
    const result = this.results.get(id);
    if (!result) throw new RelayError("NOT_FOUND", "Задача не найдена", 3, { id });
    return { ...result, blockers: [...result.blockers] };
  }
}
