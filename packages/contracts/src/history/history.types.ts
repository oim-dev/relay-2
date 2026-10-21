import type { EntityData, EntityRecord } from "../entities/entity.types";
import type {
  historyCheckpointKinds,
  historyOperatorSources,
  historyRunStates,
  historySessionStatuses,
} from "./history.constants";
import type { EntityKind } from "../entities/identity.types";

/**
 * Состояние рабочей сессии из historySessionStatuses.
 */
export type HistorySessionStatus = (typeof historySessionStatuses)[number];

/**
 * Вид неизменяемого материала истории из historyCheckpointKinds.
 */
export type HistoryCheckpointKind = (typeof historyCheckpointKinds)[number];

/**
 * Сведения о пользователе, от имени которого действует исполнитель.
 * Эти сведения не заменяют actor при проверке владения рабочей сессией.
 */
export interface HistoryOperator {
  /* Имя пользователя; null означает, что имя не известно. */
  name: string | null;
  /* Адрес электронной почты пользователя; null означает, что адрес не известен. */
  email: string | null;
  /* Источник сведений, включая наследование из родительского участия. */
  source: (typeof historyOperatorSources)[number];
}

/**
 * Одно участие исполнителя в сессии, включая контекст подключения и завершения.
 * Участие изменяется в составе сессии и защищено её ревизией, отдельной ревизии нет.
 */
export interface HistoryRun {
  /* Постоянный ID участия; именно он используется для владельческой записи. */
  id: string;
  /* Читаемый ключ участия вида RUN-<id>; не заменяет постоянный ID при записи. */
  key: string;
  /* Идентичность исполнителя, сохранённая дословно после validateActor. */
  actor: string;
  /* Состояние участия из historyRunStates. */
  state: (typeof historyRunStates)[number];
  /* Объяснение подключения; null, если причина не передана. */
  reason: string | null;
  /* Сведения о пользователе; null при их отсутствии или явном отказе от наследования. */
  operator: HistoryOperator | null;
  /* Обозначение вызывающего клиента; null, если клиент не указан. */
  client: string | null;
  /* ID сессии вызывающего клиента, не ссылка Relay; null при отсутствии. */
  sourceSessionId: string | null;
  /* Постоянный ID предыдущего участия этой сессии; null у первого участия. */
  predecessorRunId: string | null;
  /* Время начала участия в ISO 8601. */
  startedAt: string;
  /* Время завершения участия в ISO 8601; null у активного участия. */
  endedAt: string | null;
  /* Объяснение завершения или передачи ответственности; null у активного участия. */
  endReason: string | null;
}

/**
 * Поля рабочей сессии с историей ответственности и происхождением дочерней работы.
 */
interface HistorySessionFields {
  /* Непустой однострочный заголовок рабочей сессии. */
  title: string;
  /* Описание работы; null, если не задано. */
  description: string | null;
  /* Текущее состояние сессии из historySessionStatuses. */
  status: HistorySessionStatus;
  /* Постоянный ID активного участия; null у сессии без текущего владельца. */
  currentRunId: string | null;
  /* Участия в порядке подключения; у ожидающей дочерней сессии массив пуст. */
  runs: HistoryRun[];
  /* Постоянный ID родительской сессии; null у корневой работы. */
  parentSessionId: string | null;
  /* Постоянный ID намерения родителя, породившего работу; null у корневой сессии. */
  originCheckpointId: string | null;
  /* Постоянный ID участия родителя, создавшего поручение; null у корневой сессии. */
  createdByRunId: string | null;
  /* Итог завершения или отмены; null у незакрытой сессии. */
  result: string | null;
  /* Время закрытия в ISO 8601; null у незакрытой сессии. */
  closedAt: string | null;
}

/**
 * Содержимое сессии, изменяемое Core как транзакционный черновик.
 * EntityData сохраняет совместимость с JSON-контрактом EntityRecord.
 */
export type HistorySessionData = EntityData<HistorySessionFields>;

/**
 * Снимок адреса и названия цели на момент записи материала истории.
 * Последующее переименование цели не изменяет этот снимок.
 */
export interface HistoryReference {
  /* Постоянный ID целевой сущности проекта. */
  id: string;
  /* Вид целевой сущности на момент записи снимка. */
  kind: EntityKind;
  /* Читаемый ключ цели на момент записи снимка. */
  key: string;
  /* Название цели на момент записи; для незаполненного продукта используется ключ. */
  title: string;
}

/**
 * Поля неизменяемого материала, добавляемого в историю рабочей сессии.
 * Материал и увеличение ревизии сессии записываются одной транзакцией Core.
 */
interface HistoryCheckpointFields {
  /* Вид материала: намерение, прогресс, результат либо отмена. */
  kind: HistoryCheckpointKind;
  /* Постоянный ID сессии-владельца материала. */
  sessionId: string;
  /* Постоянный ID участия, владеющего сессией в момент записи. */
  runId: string;
  /* Автор активного участия, выполнившего запись. */
  actor: string;
  /* Постоянный ID исходного намерения; null только у материала вида intent. */
  intentId: string | null;
  /* Положительный порядковый номер материала внутри сессии, возрастающий при добавлении. */
  sequence: number;
  /* Ревизия сессии после записи материала; ревизия самого материала всегда равна 1. */
  sessionRevision: number;
  /* Непустой однострочный заголовок материала. */
  title: string;
  /* Непустое основное содержимое материала. */
  body: string;
  /* Краткая сводка; null, если не задана. */
  summary: string | null;
  /* Описание выполненного; null, если не задано. */
  done: string | null;
  /* Описание оставшейся работы; null, если не задано. */
  remaining: string | null;
  /* Предлагаемый следующий шаг; null, если не задан. */
  nextStep: string | null;
  /* Описание выполненных проверок; null, если не задано. */
  checks: string | null;
  /* Снимки предметных ссылок в порядке ввода, без повторов постоянного ID. */
  references: HistoryReference[];
  /* ID завершённых прямых детей исходного намерения, принятых этим материалом, без повторов. */
  acceptedSessionIds: string[];
}

/**
 * Содержимое материала истории, совместимое с JSON-контрактом хранения.
 * После добавления предметный API не разрешает его изменять.
 */
export type HistoryCheckpointData = EntityData<HistoryCheckpointFields>;

/**
 * Декодированная рабочая сессия; ревизия охватывает содержание и участия.
 */
export interface HistorySession extends Omit<EntityRecord, "kind" | "data"> {
  /* Дискриминатор рабочей сессии. */
  kind: "work-session";
  /* Проверенные данные сессии и история её ответственности. */
  data: HistorySessionData;
}

/**
 * Декодированный неизменяемый материал истории с собственной ревизией 1.
 */
export interface HistoryCheckpoint extends Omit<EntityRecord, "kind" | "data"> {
  /* Дискриминатор материала истории. */
  kind: "work-checkpoint";
  /* Проверенный материал со снимками предметных ссылок. */
  data: HistoryCheckpointData;
}

/**
 * Согласованный контекст рабочей сессии для продолжения работы.
 * Материалы, открытые намерения и прямые дети относятся к одному снимку Core.
 */
export interface HistoryContext {
  /* Полная карточка выбранной сессии с текущей ревизией. */
  session: HistorySession;
  /* Материалы самой сессии в хронологическом порядке, включая закрытые намерения. */
  checkpoints: HistoryCheckpoint[];
  /* Открытые намерения самой сессии в порядке истории; намерения детей не включены. */
  intents: HistoryCheckpoint[];
  /* Прямые дочерние сессии, включая завершённые и отменённые. */
  children: HistorySession[];
}

/**
 * Контекст нового участия; обработчик не изменяет переданные сведения.
 * Отсутствующий operator допускает наследование при attach, явный null его запрещает.
 */
export interface HistoryConnectionInput {
  /* Обозначение клиента; отсутствие сохраняется как null. */
  readonly client?: string;
  /* ID внешней сессии клиента; отсутствие сохраняется как null. */
  readonly sourceSessionId?: string;
  /* Объяснение подключения; отсутствие сохраняется как null, takeover требует значение. */
  readonly reason?: string;
  /* Пользователь участия; отсутствие и null различаются правилами наследования. */
  readonly operator?: Readonly<HistoryOperator> | null;
}

/**
 * Ввод создания корневой сессии и первого активного участия.
 */
export interface HistoryStartInput extends HistoryConnectionInput {
  /* Непустой однострочный заголовок создаваемой сессии. */
  readonly title: string;
  /* Непустое описание, если задано; отсутствие сохраняется как null. */
  readonly description?: string;
}

/**
 * Ввод дочернего поручения, создаваемого из открытого намерения родителя.
 * Ожидаемая ревизия передаётся отдельно и принадлежит родительской сессии.
 */
export interface HistoryForkInput {
  /* Непустой однострочный заголовок дочерней работы. */
  readonly title: string;
  /* Непустое описание, если задано; отсутствие сохраняется как null. */
  readonly description?: string;
  /* Постоянный ID активного участия родителя, владеющего исходным намерением. */
  readonly runId: string;
}

/**
 * Действие записи истории: открытие намерения, промежуточная запись или его закрытие.
 */
export type HistoryCheckpointAction = "open" | "save" | "complete" | "cancel";

/**
 * Ввод добавления материала истории; ревизия отдельно относится к сессии-владельцу.
 * Необязательные тексты, если переданы, непустые; отсутствие сохраняется как null.
 * Отсутствующие коллекции сохраняются пустыми массивами.
 */
export interface HistoryCheckpointInput {
  /* Постоянный ID активного участия, чей actor должен совпадать с автором записи. */
  readonly runId: string;
  /* Непустой однострочный заголовок материала. */
  readonly title: string;
  /* Непустое основное содержимое материала. */
  readonly body: string;
  /* Краткая сводка; отсутствие означает, что сводка не задана. */
  readonly summary?: string;
  /* Выполненная работа; отсутствие означает, что описание не задано. */
  readonly done?: string;
  /* Оставшаяся работа; отсутствие означает, что описание не задано. */
  readonly remaining?: string;
  /* Следующий шаг; отсутствие означает, что шаг не задан. */
  readonly nextStep?: string;
  /* Выполненные проверки; отсутствие означает, что описание не задано. */
  readonly checks?: string;
  /* Пользовательские ссылки в порядке ввода, без повторов разрешённой сущности. */
  readonly references?: readonly string[];
  /* Только ID завершённых прямых детей исходного намерения без повторов; запрещено для open. */
  readonly acceptedSessionIds?: readonly string[];
}
