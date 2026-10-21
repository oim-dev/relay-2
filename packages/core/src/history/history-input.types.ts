import type { HistoryOperator, HistorySessionStatus } from "@relay/contracts";

/**
 * Ограничения текста при проверке ввода и декодировании сохранённой истории.
 */
export interface HistoryTextOptions {
  /* Запрещает переводы строк; отсутствие свойства допускает многострочный текст. */
  readonly singleLine?: boolean;
}

/**
 * Проверенные сведения о подключении нового участия к сессии.
 */
export interface HistoryConnection {
  /* Название клиента; null означает, что клиент не указан. */
  readonly client: string | null;
  /* ID сессии внешнего инструмента; null означает отсутствие привязки. */
  readonly sourceSessionId: string | null;
  /* Основание подключения без нормализации; null означает отсутствие причины. */
  readonly reason: string | null;
  /* undefined разрешает наследование при attach; null явно отключает пользователя. */
  readonly operator: Readonly<HistoryOperator> | null | undefined;
}

/**
 * Проверенное содержание поручения без состояния участия и происхождения.
 */
export interface HistorySessionContent {
  /* Непустой однострочный заголовок, сохраняемый дословно. */
  readonly title: string;
  /* Описание без нормализации; null означает, что описание не передано. */
  readonly description: string | null;
}

/**
 * Проверенный ввод создания корневой сессии и её первого участия.
 */
export interface HistoryStartValues extends HistorySessionContent, HistoryConnection {}

/**
 * Создание дочернего поручения из открытого намерения родительской сессии.
 */
export interface HistoryForkTransition extends HistorySessionContent {
  /* Действие над исходным намерением, а не над ссылкой сессии. */
  readonly action: "fork";
  /* Постоянный ID текущего участия родителя, которому принадлежит запись. */
  readonly runId: string;
}

/**
 * Первое подключение ребёнка либо возобновление приостановленной сессии.
 */
export interface HistoryAttachTransition extends HistoryConnection {
  /* attach требует pending, resume требует paused. */
  readonly action: "attach" | "resume";
}

/**
 * Передача открытой сессии новому участию с обязательным основанием.
 */
export interface HistoryTakeoverTransition extends HistoryConnection {
  /* Передача завершает прежнее участие состоянием transferred. */
  readonly action: "takeover";
  /* Непустое основание передачи; сохраняется в обоих участиях. */
  readonly reason: string;
}

/**
 * Проверенное подключение, создающее новое участие в сессии.
 */
export type HistoryConnectTransition = HistoryAttachTransition | HistoryTakeoverTransition;

/**
 * Приостановка открытой сессии её текущим участником.
 */
export interface HistoryPauseTransition {
  /* Приостановка сохраняет незакрытые намерения сессии. */
  readonly action: "pause";
  /* Постоянный ID текущего участия, которому принадлежит запись. */
  readonly runId: string;
  /* Непустое основание приостановки без нормализации. */
  readonly reason: string;
}

/**
 * Окончательное закрытие сессии после закрытия намерений и дочерней работы.
 */
export interface HistoryCloseTransition {
  /* complete завершает работу, cancel отменяет её. */
  readonly action: "complete" | "cancel";
  /* ID текущего участия; null допустим только при отмене pending/paused-сессии. */
  readonly runId: string | null;
  /* Непустой итог закрытия без нормализации. */
  readonly result: string;
}

/**
 * Проверенный переход; действие определяет доступные поля и владельца записи.
 */
export type HistoryTransition =
  | HistoryForkTransition
  | HistoryConnectTransition
  | HistoryPauseTransition
  | HistoryCloseTransition;

/**
 * Проверенный материал до разрешения пользовательских ссылок и проверки принятия детей.
 */
export interface HistoryCheckpointValues {
  /* Постоянный ID текущего участия сессии, которому принадлежит запись. */
  readonly runId: string;
  /* Непустой однострочный заголовок материала без нормализации. */
  readonly title: string;
  /* Непустое содержание материала, сохраняемое дословно. */
  readonly body: string;
  /* Краткое резюме; null означает отсутствие. */
  readonly summary: string | null;
  /* Выполненная работа; null означает отсутствие. */
  readonly done: string | null;
  /* Оставшаяся работа; null означает отсутствие. */
  readonly remaining: string | null;
  /* Следующий шаг; null означает отсутствие. */
  readonly nextStep: string | null;
  /* Проверки и основания результата; null означает отсутствие. */
  readonly checks: string | null;
  /* Уникальные строки ссылок в порядке ввода; разные адреса одной записи проверяются позже. */
  readonly references: readonly string[];
  /* Уникальные постоянные ID принимаемых детей; для open массив всегда пуст. */
  readonly acceptedSessionIds: readonly string[];
}

/**
 * Проверенные фильтры списка сессий до разрешения ссылки родителя.
 */
export interface HistoryFilters {
  /* Требуемый статус; undefined отключает фильтр. */
  readonly status: HistorySessionStatus | undefined;
  /* true выбирает незавершённые сессии, false — закрытые; undefined отключает фильтр. */
  readonly unfinished: boolean | undefined;
  /* Ссылка родителя; null выбирает корни, undefined отключает фильтр. */
  readonly parent: string | null | undefined;
  /* Автор хотя бы одного участия; null отключает фильтр. */
  readonly actor: string | null;
  /* Подстрока в нижнем регистре для поиска по содержанию; null отключает поиск. */
  readonly query: string | null;
}

/**
 * Область поиска открытых намерений сессии.
 */
export interface HistoryIntentsOptions {
  /* Включает всё дерево потомков; по умолчанию учитывается только сама сессия. */
  readonly includeChildren?: boolean;
}
