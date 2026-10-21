import type { TaskColumn, TaskCriterion } from "@relay/contracts";
import type { TASK_CRITERION_ACTIONS, TASK_FILTER_VALUES } from "./task-constants";

export type { TaskTextOptions } from "./task-text.types";

/**
 * Проверенные поля создания; ссылки ещё требуют разрешения в транзакции проекта.
 */
export interface CreateTaskInput {
  /* Пользовательская ссылка на доску; по умолчанию BOARD-PRODUCT. */
  readonly board: string;
  /* Однострочный заголовок; отсутствие входного поля даёт пустую строку. */
  readonly title: string;
  /* Описание в свободном формате; по умолчанию пустая строка. */
  readonly description: string;
  /* Начальная колонка; по умолчанию inbox. */
  readonly column: TaskColumn;
  /* Пользовательская ссылка на родителя; null означает отсутствие родителя. */
  readonly parent: string | null;
  /* Пользовательские ссылки обязательств; уникальность проверяется после разрешения. */
  readonly dependencies: readonly string[];
  /* Пользовательские ссылки необязательных связей; порядок сохраняется. */
  readonly related: readonly string[];
  /* Пользовательские ссылки целей; допустимость определяется доской. */
  readonly targets: readonly string[];
  /* Новые невыполненные критерии с отдельными UUID в порядке ввода. */
  readonly acceptanceCriteria: readonly TaskCriterion[];
}

/**
 * Проверенная частичная правка содержания; undefined сохраняет прежнее поле.
 */
export interface UpdateTaskInput {
  /* Новый однострочный заголовок; пустая строка разрешена. */
  readonly title: string | undefined;
  /* Новое описание; пустая строка очищает текст. */
  readonly description: string | undefined;
  /* Новый полный список ссылок целей; пустой массив снимает все цели. */
  readonly targets: readonly string[] | undefined;
}

/**
 * Проверенный перенос; undefined сохраняет текущую доску или колонку.
 */
export interface MoveTaskInput {
  /* Пользовательская ссылка на новую доску. */
  readonly board: string | undefined;
  /* Новая колонка; завершение дополнительно проверяет граф обязательств. */
  readonly column: TaskColumn | undefined;
}

/**
 * Проверенная ссылка для прямого либо расширенного отбора по продуктовой цели.
 */
export interface TaskTargetFilter {
  /* Пользовательская ссылка на фичу, сценарий или реализацию. */
  readonly reference: string;
  /* product раскрывает дочерние сценарии и активные реализации; direct не раскрывает. */
  readonly scope: "direct" | "product";
}

/**
 * Проверенные фильтры до разрешения ссылок; undefined означает отсутствие ограничения.
 */
export interface TaskFilterInput {
  /* Пользовательская ссылка на доску. */
  readonly board: string | undefined;
  /* Точная сохранённая колонка. */
  readonly column: TaskColumn | undefined;
  /* Ссылка на родителя; null выбирает корневые задачи. */
  readonly parent: string | null | undefined;
  /* Отбор по сохранённым done/cancelled, без вычисления транзитивного выполнения. */
  readonly completion: (typeof TASK_FILTER_VALUES.completion)[number] | undefined;
  /* all включает описание; оба режима ищут также по ID, ключу и заголовку. */
  readonly searchIn: (typeof TASK_FILTER_VALUES.searchIn)[number];
  /* Поисковая строка в нижнем регистре; пустая строка не ограничивает выдачу. */
  readonly query: string;
  /* Вычисляемая готовность по внешним обязательствам и колонке ready. */
  readonly readiness: (typeof TASK_FILTER_VALUES.readiness)[number] | undefined;
  /* Цель отбора; undefined не ограничивает цели задачи. */
  readonly target: TaskTargetFilter | undefined;
  /* Пустой исходный объект позволяет прочитать ограниченное SQL-окно. */
  readonly unfiltered: boolean;
}

/**
 * Содержание критерия без идентичности и отметки выполнения.
 */
export type TaskCriterionContent = Readonly<
  Pick<TaskCriterion, "title" | "summary" | "description">
>;

/**
 * Поддерживаемое действие над критерием приёмки.
 */
export type TaskCriterionAction = (typeof TASK_CRITERION_ACTIONS)[number];

/**
 * Проверенное добавление нового невыполненного критерия.
 */
export interface AddTaskCriterion {
  /* Дискриминатор команды добавления. */
  readonly action: "add";
  /* Критерий с новым UUID; принадлежность задаче появляется только при записи. */
  readonly criterion: TaskCriterion;
}

/**
 * Проверенная частичная правка текста существующего критерия.
 */
export interface UpdateTaskCriterion {
  /* Дискриминатор команды изменения содержания. */
  readonly action: "update";
  /* Постоянный ID критерия внутри изменяемой задачи. */
  readonly criterionId: string;
  /* Хотя бы одно поле; отсутствие свойства сохраняет текущее значение. */
  readonly fields: Partial<TaskCriterionContent>;
}

/**
 * Проверенное изменение отметки либо удаление существующего критерия.
 */
export interface ChangeTaskCriterionState {
  /* Действие без изменения текста критерия. */
  readonly action: Exclude<TaskCriterionAction, "add" | "update">;
  /* Постоянный ID критерия внутри изменяемой задачи. */
  readonly criterionId: string;
}

/**
 * Команда критерия, в которой действие определяет допустимую форму данных.
 */
export type TaskCriterionChange = AddTaskCriterion | UpdateTaskCriterion | ChangeTaskCriterionState;

/**
 * Проверенная команда изменения одной направленной связи задачи.
 */
export interface TaskLinkChange {
  /* Связь обязательств либо необязательная связь без влияния на прогресс. */
  readonly field: "dependencies" | "related";
  /* Добавление идемпотентно; удаление отсутствующей связи также является no-op. */
  readonly action: "add" | "remove";
  /* Проверенная пользовательская ссылка; постоянный ID разрешается в транзакции. */
  readonly target: string;
}

/**
 * Автор и время отметки выполнения, переданные чистому расчёту сценария.
 */
export interface TaskCriterionCompletion {
  /* Проверенный автор текущей записи содержания задачи. */
  readonly actor: string;
  /* Момент выполнения в ISO 8601; применяется только при новой отметке. */
  readonly timestamp: string;
}
