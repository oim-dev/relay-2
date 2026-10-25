import type { TaskColumn, TaskComment, TaskCriterion, TaskRecord } from "@relay/contracts";
import type { TASK_RELATION_ACTIONS } from "../config/task-actions";

/**
 * Желаемые тексты задачи; адаптер отправляет только отличия от исходного снимка.
 */
export type TaskContentInput = Readonly<Pick<TaskRecord["data"], "title" | "description">>;

/**
 * Размещение задачи после действия; не содержит полей её содержания.
 */
export interface TaskPlacementInput {
  /* Постоянный ID выбранной доски. */
  readonly boardId: string;
  /* Проверенная колонка из текущего Contracts. */
  readonly column: TaskColumn;
}

/**
 * Создание задачи по постоянным ID; отсутствие parentId создаёт корневую задачу.
 */
export interface TaskCreateInput extends TaskContentInput, TaskPlacementInput {
  /* Постоянный ID родителя; отсутствие не добавляет поле parent в команду. */
  readonly parentId?: string;
}

/**
 * Тексты критерия, независимо от его отметки выполнения.
 */
export type TaskCriterionContent = Readonly<
  Pick<TaskCriterion, "title" | "summary" | "description">
>;

/**
 * Создание или изменение текстов критерия с исходным содержанием для частичного update.
 */
export interface TaskCriterionEditInput {
  /* null создаёт новый критерий; иначе постоянный ID внутри исходной задачи. */
  readonly criterionId: string | null;
  /* Исходные тексты; при создании игнорируются. */
  readonly original: TaskCriterionContent;
  /* Желаемые тексты; непереданные транспортные поля определяет адаптер. */
  readonly content: TaskCriterionContent;
}

/**
 * Добавляемая запись независимого журнала; не включает CAS задачи.
 */
export type TaskCommentInput = Readonly<Pick<TaskComment, "title" | "body">>;

/**
 * Действие над связью из единого доменного перечня.
 */
export type TaskRelationAction = (typeof TASK_RELATION_ACTIONS)[number];

/**
 * Изменение связи по ID: снятие родителя не имеет целевого адреса.
 */
export type TaskRelationInput =
  | {
      /* Снимает текущую связь с родителем. */
      readonly action: "parent.clear";
    }
  | {
      /* Назначение родителя либо добавление/снятие одной связи. */
      readonly action: Exclude<TaskRelationAction, "parent.clear">;
      /* Постоянный ID выбранной задачи или предметной цели. */
      readonly targetId: string;
    };
