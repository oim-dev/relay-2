import type {
  PlanStage,
  PlanStatus,
  ReleaseFields,
  ReleaseStatus,
  WorkPlanFields,
} from "./planning.types";

/**
 * Поля создания плана с коллекциями, которыми владеет вызывающая сторона.
 */
interface WorkPlanInputFields extends Omit<WorkPlanFields, "participants" | "scope"> {
  /* Имена участников без повторов; обработчик не изменяет переданный массив. */
  readonly participants: Readonly<WorkPlanFields["participants"]>;
  /* Предметные ссылки области; обработчик не изменяет массив и его элементы. */
  readonly scope: readonly Readonly<WorkPlanFields["scope"][number]>[];
}

/**
 * Ввод создания плана: заголовок обязателен, остальные поля заполняются независимо.
 * Core заменяет отсутствующие тексты пустыми строками, коллекции — пустыми массивами.
 */
export type WorkPlanInput = Readonly<
  Pick<WorkPlanInputFields, "title"> & Partial<WorkPlanInputFields>
>;

/**
 * Поля создания релиза с составом, которым владеет вызывающая сторона.
 */
interface ReleaseInputFields extends Omit<ReleaseFields, "planIds"> {
  /* Непустой состав ссылок на планы без повторов; обработчик не изменяет массив. */
  readonly planIds: Readonly<ReleaseFields["planIds"]>;
}

/**
 * Ввод создания релиза с обязательными названием, версией и составом планов.
 * Отсутствующие необязательные тексты Core сохраняет пустыми строками.
 */
export type ReleaseInput = Readonly<
  Pick<ReleaseInputFields, "title" | "version" | "planIds"> & Partial<ReleaseInputFields>
>;

/**
 * Редактируемые текстовые поля этапа без его идентичности и состава задач.
 */
export type StageFields = Pick<PlanStage, "title" | "summary" | "outcome" | "completionConditions">;

/**
 * Создание этапа с уже заполненными текстовыми полями.
 */
interface CreateStageChange {
  /* Действие, выбирающее форму параметров создания. */
  readonly action: "create";
  /* Поля нового этапа; ID выделяет Core, состав задач изначально пуст. */
  readonly fields: Readonly<StageFields>;
  /* ID этапа, перед которым вставить новый; null добавляет в конец плана. */
  readonly before: string | null;
}

/**
 * Изменение выбранных текстовых полей существующего этапа.
 */
interface UpdateStageChange {
  /* Действие, выбирающее форму параметров изменения. */
  readonly action: "update";
  /* Постоянный ID этапа внутри выбранного плана. */
  readonly stageId: string;
  /* Непустой набор правок; отсутствующие поля сохраняют прежнее значение. */
  readonly fields: Readonly<Partial<StageFields>>;
}

/**
 * Удаление этапа; Core допускает его только при пустом составе задач.
 */
interface RemoveStageChange {
  /* Действие, выбирающее удаление этапа. */
  readonly action: "remove";
  /* Постоянный ID удаляемого этапа внутри выбранного плана. */
  readonly stageId: string;
}

/**
 * Точная позиция этапа относительно другого этапа того же плана.
 */
interface StagePosition {
  /* ID этапа, перед которым разместить перемещаемый; null означает конец плана. */
  readonly before: string | null;
}

/**
 * Перестановка этапа на одну позицию; выход за границы порядка даёт no-op.
 */
interface StageDirection {
  /* Направление относительно текущего порядка этапов. */
  readonly direction: "up" | "down";
}

/**
 * Изменение позиции этапа с сохранением его ID, содержания и состава задач.
 */
interface MoveStageChange {
  /* Действие, выбирающее перестановку этапа. */
  readonly action: "move";
  /* Постоянный ID перемещаемого этапа внутри выбранного плана. */
  readonly stageId: string;
  /* Точная позиция либо направление; проверка ввода допускает ровно один вариант. */
  readonly destination: StagePosition | StageDirection;
}

/**
 * Проверенное изменение этапа; action определяет допустимые параметры.
 * Ревизией, атомарной записью и проверкой no-op владеет сценарий плана в Core.
 */
export type StageChange =
  CreateStageChange | UpdateStageChange | RemoveStageChange | MoveStageChange;

/**
 * Запуск рабочего плана без итогового текста.
 */
interface StartPlanTransition {
  /* Переход плана из черновика в активное состояние. */
  readonly action: "start";
}

/**
 * Закрытие рабочего плана с обязательной фиксацией итога.
 */
interface ClosePlanTransition {
  /* Завершение либо отмена плана; допустимость определяет сценарий Core. */
  readonly action: "complete" | "cancel";
  /* Непустое описание результата либо причины отмены. */
  readonly result: string;
}

/**
 * Переход состояния плана; закрывающие действия требуют итоговый текст.
 */
export type PlanTransition = StartPlanTransition | ClosePlanTransition;

/**
 * Действие жизненного цикла релиза: восстановление плана выпуска, отмена или публикация.
 */
export type ReleaseTransition = "plan" | "cancel" | "publish";

/**
 * Проверенные параметры переноса задачи между планами; ссылки ещё разрешает Core.
 */
export interface PlanTaskTransfer {
  /* Пользовательская ссылка на переносимую задачу. */
  readonly task: string;
  /* Пользовательская ссылка на план назначения. */
  readonly targetPlan: string;
  /* Постоянный ID этапа в плане назначения. */
  readonly targetStage: string;
  /* Обязательное непустое объяснение переноса; проверяется без записи комментария задачи. */
  readonly reason: string;
}

/**
 * Условия отбора планов или релизов; отсутствие поля отключает соответствующий фильтр.
 */
export interface PlanningFilter {
  /* Непустой поисковый текст либо адрес записи; Core также ищет по содержанию. */
  readonly q?: string;
  /* Статус выбранного вида записи; сочетание с видом проверяет Core. */
  readonly status?: PlanStatus | ReleaseStatus;
}
