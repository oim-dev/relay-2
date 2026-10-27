import type { KnowledgeRecord, TaskRecord } from "@relay/contracts";
import type { TaskGraphNode } from "./task-graph.types";

/**
 * Сохранённая карточка либо узкая графовая проекция на границе декодирования.
 */
export interface StoredTask {
  /* Постоянный ID задачи для результата и структурированной диагностики. */
  readonly id: string;
  /* Читаемый ключ задачи для сообщения о повреждении. */
  readonly key: string;
  /* Непроверенное содержание; форму определяет полный либо графовый декодер. */
  readonly data: unknown;
}

/**
 * Проверенные виды знаний, которые могут участвовать в выборе целей задачи.
 */
export type TaskTarget = KnowledgeRecord<"feature" | "scenario" | "implementation">;

/**
 * Проверенные поля отбора и компактной карточки, не полная задача с журналом.
 * description отсутствует в metadata-чтении; поиск по описанию использует полный TaskRecord.
 */
export interface TaskViewRecord extends Omit<TaskRecord, "data"> {
  /* Поля фильтров и графа; полные тексты критериев и комментарии намеренно не входят. */
  readonly data: Pick<
    TaskRecord["data"],
    "boardId" | "title" | "column" | "parentId" | "dependencies" | "related" | "targets"
  > & {
    /* Текст для явно запрошенного полнотекстового поиска; отсутствует в узком чтении. */
    readonly description?: string;
    /* Только проверенные отметки из графовой проекции того же snapshot. */
    readonly acceptanceCriteria: TaskGraphNode["acceptanceCriteria"];
  };
}
