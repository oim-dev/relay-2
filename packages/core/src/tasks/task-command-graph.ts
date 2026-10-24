import type { TaskRecord } from "@relay/contracts";
import { taskGraphNode } from "./task-data";
import type { StoredTask } from "./task-data.types";
import { TaskGraph } from "./task-graph";

/**
 * Чистый кеш последнего графового состояния одного исполнения, общий для задач и планирования.
 * Сравнивает обязательства и наблюдаемый порядок key/id; новые массивы, тексты и журналы
 * не инвалидируют расчёт. Порядок детей совпадает с синхронным чтением графа из Storage.
 * Не читает хранилище, не меняет входные записи и не переживает command execution.
 */
export class TaskGraphCache {
  /* Каноническое содержание последнего успешно рассчитанного графа. */
  private signature: string | undefined;
  /* Единственный граф, соответствующий signature; более старые состояния не удерживаются. */
  private graph: TaskGraph | undefined;

  /**
   * Рассчитывает общий граф с подменой кандидата либо возвращает расчёт того же состояния.
   * Кандидат может быть новым узлом; результат учитывает его до применения exact effects.
   */
  get(records: readonly StoredTask[], candidate?: TaskRecord): TaskGraph {
    const selected: StoredTask[] = records.filter((record) => record.id !== candidate?.id);
    if (candidate !== undefined) {
      selected.push(candidate);
    }
    selected.sort((left, right) => {
      if (left.key !== right.key) {
        return left.key < right.key ? -1 : 1;
      }
      return left.id === right.id ? 0 : left.id < right.id ? -1 : 1;
    });
    const nodes = selected.map(taskGraphNode);
    const signature = JSON.stringify(nodes);
    if (this.graph !== undefined && signature === this.signature) {
      return this.graph;
    }
    const graph = new TaskGraph(nodes);
    this.signature = signature;
    this.graph = graph;
    return graph;
  }
}
