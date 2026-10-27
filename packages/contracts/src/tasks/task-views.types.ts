import type { EntityRecord } from "../entities/entity.types";
import type { EntityPageRequest } from "../pagination/pagination.types";
import type { TaskColumn, TaskProgress } from "./tasks.types";

/**
 * Компактная карточка задачи без описания, текстов критериев и журнала комментариев.
 * Все ссылки, прогресс и реквизиты доски относятся к одному снимку страницы.
 */
export interface TaskView extends Pick<
  EntityRecord,
  "id" | "key" | "revision" | "createdAt" | "updatedAt" | "createdBy" | "updatedBy"
> {
  /* Сохранённый заголовок; пустая строка допустима. */
  readonly title: string;
  /* Постоянный ID доски. */
  readonly boardId: string;
  /* Текущий адрес доски для навигации. */
  readonly boardSlug: string;
  /* Сохранённая колонка; не заменяется вычисленной готовностью. */
  readonly column: TaskColumn;
  /* Постоянный ID родителя; null у корневой задачи. */
  readonly parentId: string | null;
  /* Постоянные ID прямых обязательных зависимостей. */
  readonly dependencies: readonly string[];
  /* Постоянные ID необязательных связей. */
  readonly related: readonly string[];
  /* Проверенные виды и постоянные ID явно назначенных целей. */
  readonly targets: readonly TaskViewTarget[];
  /* Счётчики собственных критериев, без их текстов. */
  readonly acceptance: {
    /* Число собственных критериев задачи. */
    readonly total: number;
    /* Число сохранённых выполненных отметок собственных критериев. */
    readonly completed: number;
  };
  /* Текущая готовность из общего графа задач страницы. */
  readonly progress: TaskProgress;
}

/**
 * Идентичность цели задачи, разрешённая в текущем снимке.
 */
export interface TaskViewTarget {
  /* Вид назначенной цели из действующей модели задач. */
  readonly kind: "feature" | "scenario" | "implementation";
  /* Постоянный ID цели, не читаемый ключ. */
  readonly id: string;
}

/**
 * Сводка всего выбранного набора задач, а не готовность продукта или приложения.
 */
export interface TaskViewCounts {
  /* Число задач до применения offset/limit. */
  readonly total: number;
  /* Фактически выполненные задачи по TaskGraph. */
  readonly completed: number;
  /* Непустой выбранный набор целиком фактически выполнен; не готовность продуктовой цели. */
  readonly allCompleted: boolean;
  /* Выполненные задачи с хотя бы одной явной целью. */
  readonly targetedCompleted: number;
  /* Все задачи с хотя бы одной явной целью. */
  readonly targetedTotal: number;
  /* Число задач с невыполненными прямыми обязательствами. */
  readonly blocked: number;
  /* Счётчики сохранённых колонок полного выбранного набора. */
  readonly columns: Readonly<Record<TaskColumn, number>>;
}

/**
 * Ограниченная страница, сводка и поколение одного снимка проекта.
 */
export interface TaskViewPage {
  /* Только окно компактных карточек в запрошенном порядке. */
  readonly items: readonly TaskView[];
  /* Число выбранных задач, включая элементы вне окна. */
  readonly total: number;
  /* Сводка выбранного набора до окна. */
  readonly counts: TaskViewCounts;
  /* Поколение общего snapshot; обязательно для продолжения. */
  readonly generation: number;
  /* Следующее смещение; null, когда весь набор просмотрен. */
  readonly nextOffset: number | null;
}

/**
 * Текущие фильтры задач и параметры компактного чтения.
 * ref выбирает одну задачу по обычным правилам адресации и сохраняет остальные фильтры.
 */
export interface TaskViewQuery extends Partial<EntityPageRequest> {
  /* Исходное поколение; обязательно при offset > 0. */
  readonly generation?: number;
  /* Адрес одной задачи; отсутствие не ограничивает адрес. */
  readonly ref?: string;
  /* От 1 до ENTITY_READ_SIZE.max адресов; несовместимо с ref, дубли разрешаются в один ID. */
  readonly refs?: readonly string[];
  /* Адрес доски; отсутствие включает все доски. */
  readonly board?: string;
  /* Сохранённая колонка из TASK_COLUMNS. */
  readonly column?: TaskColumn;
  /* Адрес родителя для прямых детей. */
  readonly parentId?: string;
  /* Поисковый текст по текущим правилам задач. */
  readonly q?: string;
  /* Область поиска: заголовок либо также описание. */
  readonly searchIn?: "title" | "all";
  /* Точная явно назначенная цель. */
  readonly target?: string;
  /* Цель с текущим расширением области через сценарии/активные реализации. */
  readonly productTarget?: string;
  /* Колонки done/cancelled либо остальные; это не фактический прогресс. */
  readonly completion?: "finished" | "unfinished";
  /* Готовность к старту по существующему фильтру задач. */
  readonly readiness?: "ready" | "blocked";
}

/**
 * Проверенное текущее включение задачи в незакрытый план.
 */
export interface TaskViewAssignment {
  /* Постоянный ID плана-владельца. */
  readonly planId: string;
  /* Текущий читаемый ключ плана. */
  readonly planKey: string;
  /* Постоянный ID этапа внутри плана. */
  readonly stageId: string;
  /* Сохранённый заголовок этапа. */
  readonly stageTitle: string;
}

/**
 * Параметры подбора задач без нового правила записи или резервирования.
 */
export interface TaskCandidateQuery extends TaskViewQuery {
  /* План редактируемого состава; при stageId обязателен. */
  readonly plan?: string;
  /* Этап редактируемого состава; допускает уже включённые в него задачи. */
  readonly stageId?: string;
  /* true исключает чужие открытые включения до пагинации. */
  readonly availableOnly?: boolean;
}

/**
 * Кандидат с текущим включением; null означает отсутствие открытого плана.
 */
export interface TaskCandidate extends TaskView {
  /* Текущее включение; история закрытых планов не резервирует задачу. */
  readonly assignment: TaskViewAssignment | null;
}

/**
 * Страница кандидатов с итогами после проверки доступности и до окна.
 */
export interface TaskCandidatePage extends Omit<TaskViewPage, "items"> {
  /* Только окно кандидатов; состояния и включения относятся к поколению страницы. */
  readonly items: readonly TaskCandidate[];
}
