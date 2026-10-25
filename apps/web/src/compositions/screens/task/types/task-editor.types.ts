import type { NamedCommand } from "@relay/contracts";
import type {
  TaskCommentInput,
  TaskContentInput,
  TaskCriterionContent,
  TaskRelationAction,
  TaskSnapshot,
} from "domains/tasks";

/**
 * Общий исходный снимок для самостоятельной области карточки.
 */
export interface TaskSectionProps {
  /* Текущее чтение; начатый черновик хранит собственную копию. */
  readonly snapshot: TaskSnapshot;
}

/**
 * Редактируемый текст задачи без полей других действий.
 */
export type TaskContentValues = TaskContentInput;

/**
 * Черновик текста с исходными CAS и переносимой версией.
 */
export interface TaskContentDraft {
  /* Снимок при явном начале редактирования. */
  readonly snapshot: TaskSnapshot;
  /* Несохранённые значения полей. */
  readonly values: TaskContentValues;
}

/**
 * Поля переноса задачи, не включающие содержание.
 */
export interface TaskMoveValues {
  /* Постоянный ID выбранной доски. */
  readonly board: string;
  /* Значение Select текущих колонок. */
  readonly column: string;
}

/**
 * Сохраняемый черновик переноса с отдельной исходной версией.
 */
export interface TaskMoveDraft {
  /* Снимок при начале действия. */
  readonly snapshot: TaskSnapshot;
  /* Доска и колонка пользователя. */
  readonly values: TaskMoveValues;
}

/**
 * Текст одного критерия без ID и признака выполнения.
 */
export type CriterionValues = TaskCriterionContent;

/**
 * Создание либо редактирование одного критерия под версией задачи.
 */
export interface CriterionDraft {
  /* Исходная задача и её version guards. */
  readonly snapshot: TaskSnapshot;
  /* null создаёт новый критерий; ID изменяет имеющийся. */
  readonly criterionId: string | null;
  /* Исходные тексты для передачи только изменённых полей. */
  readonly original: CriterionValues;
  /* Текущий ввод пользователя. */
  readonly values: CriterionValues;
}

/**
 * Сохранённое быстрое действие, доступное для повторной проверки исхода.
 */
export type QuickTaskCommand = NamedCommand | null;

/**
 * Значения append-only комментария, независимого от ревизии задачи.
 */
export type CommentValues = TaskCommentInput;

/**
 * Поля единичной операции над связью; пустая цель допустима лишь для снятия родителя.
 */
export interface RelationValues {
  /* Действие из локального меню, отображаемое в точную команду Core. */
  readonly action: TaskRelationAction;
  /* Постоянный ID выбранной записи. */
  readonly target: string;
  /* Вид при выборе продуктовой цели. */
  readonly targetKind: string;
}

/**
 * Черновик связи с исходным содержанием для безопасного изменения targets.
 */
export interface RelationDraft {
  /* Исходная задача, CAS и переносимая версия. */
  readonly snapshot: TaskSnapshot;
  /* Выбранное действие и адрес назначения. */
  readonly values: RelationValues;
}
