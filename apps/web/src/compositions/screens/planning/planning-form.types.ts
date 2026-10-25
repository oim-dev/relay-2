import type {
  PlanScope,
  PlanStage,
  ReleaseFields,
  ReleaseRecord,
  StageChange,
  StageFields,
  WorkPlanFields,
  WorkPlanRecord,
} from "@relay/contracts";
import type { PlanMembershipSource, PlanningSource, StageSource } from "domains/planning";

/**
 * Ввод содержания плана; начальные значения допускают незаполненный заголовок.
 */
export interface PlanFormValues extends WorkPlanFields {}
/**
 * Ввод содержания релиза до обязательной проверки состава и версии.
 */
export interface ReleaseFormValues extends ReleaseFields {}
/**
 * Редактор планирования с зафиксированным источником и явным завершением.
 */
export interface PlanFormProps {
  /* Исходный план; отсутствие открывает создание. */
  readonly source?: PlanningSource<WorkPlanRecord>;
  /* Сворачивает форму, не уничтожая сохранённый черновик. */
  readonly onClose: () => void;
}
/**
 * Редактор релиза с исходной ревизией владельца состава.
 */
export interface ReleaseFormProps {
  /* Исходный релиз; отсутствие означает создание. */
  readonly source?: PlanningSource<ReleaseRecord>;
  /* Сворачивает форму. */
  readonly onClose: () => void;
}
/**
 * Редактор этапа, принадлежащего исходному плану.
 */
export interface StageFormProps {
  /* План и необязательный редактируемый этап того же снимка. */
  readonly source: StageSource;
  /* Сворачивает редактор после успеха или по решению пользователя. */
  readonly onClose: () => void;
}
/**
 * Ввод текстов этапа, проверяемый Core при отправке.
 */
export interface StageFormValues extends StageFields {}
/**
 * Строка этапа с серверной готовностью и исходным владельцем CAS.
 */
export interface StageCardProps {
  /* Прочитанный план, которому принадлежит этап. */
  readonly source: PlanningSource<WorkPlanRecord>;
  /* Этап того же снимка, без собственной ревизии. */
  readonly stage: PlanStage;
  /* Серверный процент; отсутствие означает неизвестную готовность. */
  readonly percent: number | undefined;
  /* Другая структурная команда плана ожидает исхода. */
  readonly locked: boolean;
  /* Выполняет изменение у владельца плана, переживающего удаление строки этапа. */
  readonly onChange: (change: StageChange) => void;
}
/**
 * Переход жизненного цикла выбранной карточки.
 */
export interface PlanningTransitionProps extends PlanningTransitionEditor {
  /* Сворачивает диалог, сохраняя источник и владельца восстановления. */
  readonly onClose: () => void;
  /* Повторно открывает тот же исходный редактор. */
  readonly onOpen: () => void;
  /* Удаляет экранный выбор только после успеха или явного допустимого discard. */
  readonly onComplete: () => void;
}
/**
 * Сохраняемый экраном переход, доступный независимо от свежего статуса сущности.
 */
export interface PlanningTransitionEditor {
  /* Исходная карточка с версией; сохраняется до завершения формы. */
  readonly source: PlanningSource;
  /* Видимость Modal; false не прекращает жизнь исходной операции. */
  readonly opened: boolean;
}
/**
 * Состав этапа: добавление, исключение либо перенос одной задачи.
 */
export interface MembershipFormProps {
  /* Исходный существующий этап и план-владелец его состава. */
  readonly source: PlanMembershipSource;
  /* Сворачивает форму после успеха или по решению пользователя. */
  readonly onClose: () => void;
}
/**
 * Ввод атомарного изменения включения одной задачи.
 */
export interface MembershipValues {
  /* Выбранное действие над включением. */
  action: "add" | "remove" | "transfer";
  /* Постоянный ID задачи; пустая строка до выбора. */
  task: string;
  /* ID плана назначения; пустая строка для действий без переноса. */
  targetPlan: string;
  /* ID этапа назначения; пустая строка до выбора. */
  targetStage: string;
  /* Объяснение переноса; обязательно только для transfer. */
  reason: string;
  /* Снимок плана назначения при выборе этапа; undefined до явного выбора. */
  targetSource: PlanningSource<WorkPlanRecord> | undefined;
}
/**
 * Сохраняемый черновик связывает ввод с исходным полным снимком владельца.
 */
export interface PlanningDraft<T, S = PlanningSource | undefined> {
  /* Ввод пользователя, переживающий смену маршрута. */
  readonly values: T;
  /* Исходные содержание, CAS и переносимый токен. */
  readonly source: S;
}
/**
 * Вид цели для запроса вариантов области плана.
 */
export type ScopeKind = PlanScope["kind"];
