import type { TaskColumn } from "@relay/contracts";

/**
 * Проверенные поля обязательств; тексты и журнал задачи не участвуют в расчёте.
 */
export interface TaskGraphNode {
  /* Постоянный ID задачи в пределах проекта. */
  readonly id: string;
  /* Сохранённая колонка; только done может считаться выполнением. */
  readonly column: TaskColumn;
  /* Постоянный ID родителя; null обозначает корневую задачу. */
  readonly parentId: string | null;
  /* Уникальные постоянные ID обязательных зависимостей в сохранённом порядке. */
  readonly dependencies: readonly string[];
  /* Отметки собственных критериев; пустой список не блокирует завершение. */
  readonly acceptanceCriteria: readonly TaskGraphCriterion[];
}

/**
 * Проекция собственного критерия для расчёта выполнения задачи.
 */
export interface TaskGraphCriterion {
  /* Текущая отметка выполнения критерия, независимо от колонки задачи. */
  readonly completed: boolean;
}

/**
 * Внутреннее состояние топологического обхода; живёт только во время расчёта графа.
 */
export interface TaskGraphEntry {
  /* Неизменяемая проекция исходной задачи. */
  readonly node: TaskGraphNode;
  /* Прямые обязательства без дублей в порядке первого появления при обходе узлов. */
  readonly obligations: Set<TaskGraphEntry>;
  /* Задачи, ожидающие завершения этого узла. */
  readonly dependants: Set<TaskGraphEntry>;
  /* Число ещё не рассчитанных обязательств; ноль разрешает посещение узла. */
  remaining: number;
  /* Итог выполнения; читается ожидающими задачами только после посещения узла. */
  completed: boolean;
}
