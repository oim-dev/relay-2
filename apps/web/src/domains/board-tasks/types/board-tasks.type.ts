import type { z } from "zod";
import type {
  BOARD_TASK_SCHEMA,
  TASK_SUMMARY_SCHEMA,
  TASKS_PAGE_SCHEMA,
  LINKS_PAGE_SCHEMA,
  TASK_SAVED_SCHEMA,
  COLUMN_SCHEMA,
  RELATION_SCHEMA,
} from "../config/board-tasks.schema";

export type BoardTask = z.infer<typeof BOARD_TASK_SCHEMA>;
export type TaskSummary = z.infer<typeof TASK_SUMMARY_SCHEMA>;
export type TaskColumn = z.infer<typeof COLUMN_SCHEMA>;
export type TaskRelation = z.infer<typeof RELATION_SCHEMA>;
export type TasksPage = z.infer<typeof TASKS_PAGE_SCHEMA>;
/** Прогресс выбранного текущими фильтрами Core набора задач, не готовность продуктовой цели. */
export type ProductTaskProgress = {
  /** Всего задач с обязательством. */
  total: number;
  /** Фактически выполненные задачи с учётом всех обязательств. */
  completed: number;
};
/** Фактическое выполнение и страница блокирующих обязательств задачи из Core. */
export type TaskExecutionProgress = {
  /** Текущий план задачи; отсутствие не запрещает исполнение на этом этапе интеграции. */
  planning?: {
    /** Постоянный ID плана. */
    planId: string;
    /** Читаемый ключ. */
    planKey: string;
    /** Название этапа. */
    stageTitle: string;
  } | null;
  /** Выполнена задача с её критериями, детьми и зависимостями. */
  isComplete: boolean;
  /** Версия выбранной страницы причин. */
  version: string;
  /** Следующая страница причин. */
  nextOffset: number | null;
  /** Полное число причин. */
  reasonCount: number;
  /** Причины с адресами дальнейшего раскрытия. */
  reasons: { /** Объяснение. */ message: string; /** Путь внутри проекта. */ path: string }[];
};
/** Итоги набора и страница его задач; isComplete относится только к этому непустому набору. */
export type ProductGoalProgress = ProductTaskProgress & TaskExecutionProgress;
/** Выполнение задач с явными целями и всех задач доски, не готовность приложения. */
export type ApplicationTaskProgress = {
  /** Задачи с явными связями с требованиями, без повторов по числу связей. */
  business: ProductTaskProgress;
  /** Все задачи доски, включая отменённые и подзадачи. */
  overall: ProductTaskProgress;
};
export type TaskLinksPage = z.infer<typeof LINKS_PAGE_SCHEMA>;
export type TaskSaved = z.infer<typeof TASK_SAVED_SCHEMA>;
export type TaskFilters = {
  /** ID или ключ родителя для списка прямых подзадач. */
  parentId?: string;
  board?: string;
  column?: TaskColumn;
  q?: string;
  productTarget?: string;
  completion?: "unfinished" | "finished";
  searchIn?: "title" | "all";
  readiness?: "blocked" | "ready";
};
export type CreateTaskInput = {
  parentId?: string;
  board: string;
  title?: string;
  description?: string;
  column: TaskColumn;
  requestId: string;
};
export type EditTaskInput = {
  title?: string;
  description?: string;
  productLinks?: BoardTask["productLinks"];
  ifRevision: number;
  requestId: string;
};
export type MoveTaskInput = {
  column: TaskColumn;
  board?: string;
  ifRevision: number;
  requestId: string;
};
export type LinkTaskInput = {
  target: string;
  relation: TaskRelation;
  remove?: boolean;
  ifRevision: number;
  requestId: string;
};
