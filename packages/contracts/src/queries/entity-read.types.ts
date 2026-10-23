import type { EntityKind } from "../entities/identity.types";
import type { EntityRecord } from "../entities/entity.types";
import type { HistorySessionStatus } from "../history/history.types";
import type { DocumentData, ImplementationData } from "../knowledge/knowledge.types";
import type { PlanStatus, ReleaseStatus } from "../planning/planning.types";
import type { ProjectEntity } from "../project-entity.types";
import type { TaskColumn } from "../tasks/tasks.types";

/**
 * Идентичность и название краткой карточки без содержания и связанных составов.
 */
interface EntitySummaryIdentity extends Readonly<Pick<EntityRecord, "id" | "key" | "revision">> {
  /* Сохранённое название; для незаполненного паспорта продукта используется текущий ключ. */
  readonly title: string;
}

/**
 * Краткая карточка вида без сохранённого состояния и признака активности.
 */
interface EntitySummaryWithoutState<K extends EntityKind> {
  /* Вид записи, определяющий отсутствие предметного состояния. */
  readonly kind: K;
  /* У этого вида состояние отсутствует. */
  readonly state?: never;
  /* Признак активности применим только к реализации. */
  readonly active?: never;
}

/**
 * Сохранённое состояние краткой карточки; вычисляемая готовность сюда не входит.
 */
interface EntitySummaryWithState<K extends EntityKind, State extends string> {
  /* Вид записи, определяющий перечисление допустимых состояний. */
  readonly kind: K;
  /* Колонка задачи либо сохранённый предметный статус соответствующего вида. */
  readonly state: State;
  /* Признак активности применим только к реализации. */
  readonly active?: never;
}

/**
 * Сохранённые степень готовности и независимая активность реализации.
 */
interface ImplementationSummaryState {
  /* Дискриминатор реализации функциональности либо сценария. */
  readonly kind: "implementation";
  /* Сохранённая степень реализации; не рассчитывается по задачам. */
  readonly state: ImplementationData["status"];
  /* Сохранённый признак действующего участия приложения. */
  readonly active: boolean;
}

/**
 * Проверенная краткая карточка. Вид определяет применимость state/active и их точные типы.
 * Тексты, data, комментарии, критерии, этапы и содержимое связанных записей не включаются.
 */
export type EntitySummary = EntitySummaryIdentity &
  (
    | EntitySummaryWithoutState<
        "project" | "product" | "feature" | "scenario" | "application" | "board" | "work-checkpoint"
      >
    | EntitySummaryWithState<"task", TaskColumn>
    | EntitySummaryWithState<"document", DocumentData["documentStatus"]>
    | EntitySummaryWithState<"work-plan", PlanStatus>
    | EntitySummaryWithState<"release", ReleaseStatus>
    | EntitySummaryWithState<"work-session", HistorySessionStatus>
    | ImplementationSummaryState
  );

/**
 * Переносимая диагностика известной ошибки одного адреса группового чтения.
 */
export interface EntityReadError {
  /* Стабильный код предметного отказа, не зависящий от сообщения. */
  readonly code: string;
  /* Сообщение для человека без технического стека. */
  readonly message: string;
  /* Код завершения интерфейса при этой ошибке; первая ошибка определяется порядком входа. */
  readonly exitCode: number;
  /* Структурированные детали исходного RelayError; отсутствуют, если дополнительных данных нет. */
  readonly details?: Readonly<Record<string, unknown>>;
}

/**
 * Успешно прочитанная запись с исходным пользовательским адресом.
 */
export interface EntityReadSuccess<T> {
  /* Адрес аргумента без нормализации; может быть ID, ключом, алиасом или типизированной ссылкой. */
  readonly ref: string;
  /* Дискриминатор успешного элемента. */
  readonly ok: true;
  /* Проверенная запись в представлении, определённом полем view общего результата. */
  readonly entity: T;
}

/**
 * Ошибка одного адреса, сохраняющая своё место рядом с успешными результатами.
 */
export interface EntityReadFailure {
  /* Исходный адрес ошибочного аргумента. */
  readonly ref: string;
  /* Дискриминатор ошибочного элемента. */
  readonly ok: false;
  /* Известный отказ разрешения либо декодирования этого адреса. */
  readonly error: EntityReadError;
}

/**
 * Один результат группового чтения; ok связывает payload с успехом или ошибкой.
 */
export type EntityReadItem<T = ProjectEntity | EntitySummary> =
  EntityReadSuccess<T> | EntityReadFailure;

/**
 * Полное групповое чтение выбранных предметных записей из одного снимка.
 */
export interface EntityFullReadResult {
  /* Полное предметное представление, включая сохранённые тексты и вложенные составы. */
  readonly view: "full";
  /* Поколение проекта из того же снимка, что идентичности и записи. */
  readonly generation: number;
  /* Результат каждого аргумента в исходном порядке, включая повторы и ошибки. */
  readonly items: readonly EntityReadItem<ProjectEntity>[];
}

/**
 * Краткое групповое чтение без загрузки полных текстов и журналов в Core.
 */
export interface EntitySummaryReadResult {
  /* Краткое представление с идентичностью, названием и применимым состоянием. */
  readonly view: "summary";
  /* Поколение проекта из общего снимка чтения. */
  readonly generation: number;
  /* Результат каждого аргумента в исходном порядке, включая повторы и ошибки. */
  readonly items: readonly EntityReadItem<EntitySummary>[];
}

/**
 * Поле view однозначно определяет точный payload успешных элементов списка.
 */
export type EntityReadResult = EntityFullReadResult | EntitySummaryReadResult;

/**
 * Выбор представления группового чтения; отсутствие опции означает полные записи.
 */
export interface EntityReadOptions {
  /* true выбирает краткую SQL-проекцию; false и отсутствие выбирают полное чтение. */
  readonly summary?: boolean;
}
