import type {
  DocumentLinks,
  DocumentSections,
  KnowledgeRecord,
} from "../knowledge/knowledge.types";
import type { TaskComment, TaskCriterion, TaskProgress, TaskRecord } from "../tasks/tasks.types";
import type {
  TaskViewPage,
  TaskViewQuery,
  TaskCandidatePage,
  TaskCandidateQuery,
} from "../tasks/task-views.types";
import type {
  PlanProgress,
  ReleaseProgress,
  PlanStages,
  PlanStageResult,
  PlanStageTasks,
  ReleasePlans,
  TaskPlanMemberships,
} from "../planning/planning.types";
import type {
  HistorySession,
  HistoryCheckpoint,
  HistoryContext,
  HistorySessionStatus,
} from "../history/history.types";
import type { EntityReadResult } from "../queries/entity-read.types";
import type {
  HistoryTimelinePage,
  HistoryTimelineRequest,
} from "../history/history-timeline.types";
import type {
  RelationNeighborhood,
  RelationNeighborhoodRequest,
} from "../queries/relation-neighborhood.types";
import type { GitSyncControlOutcome } from "../replication/git-sync-control.types";
import type {
  GitSyncConflictList,
  GitSyncConflictDetails,
} from "../replication/git-sync-conflicts.types";
import type { HttpGitSyncStatus } from "./git-sync.types";
import type { ProjectEntity } from "../project-entity.types";
import type { HttpProjectCheck, HttpProjectStatus } from "./http.types";

/**
 * Независимый состав задач с исходной ревизией владельца.
 */
export interface HttpTaskCollection<T> {
  /* Ключ задачи-владельца. */
  readonly task: string;
  /* Исходная локальная ревизия содержания задачи. */
  readonly revision: number;
  /* Элементы в порядке Core. */
  readonly items: readonly T[];
}

/**
 * Результаты именованных GET-проекций реального API; никакого стирания kind/data.
 */
export interface HttpReadResults {
  /* Компактная страница и сводка выбранных текущих задач одного snapshot. */
  readonly taskViews: TaskViewPage;
  /* Ограниченная страница задач для выбора состава плана. */
  readonly taskCandidates: TaskCandidatePage;
  /* Техническое состояние без загрузки содержания проекта. */
  readonly projectStatus: HttpProjectStatus;
  /* Явная полная диагностика целостности Core. */
  readonly projectCheck: HttpProjectCheck;
  /* Разделы и ревизия проекта-владельца. */
  readonly documentSections: DocumentSections;
  /* Связи документа с исходной ревизией. */
  readonly documentLinks: DocumentLinks;
  /* Текущее участие приложения. */
  readonly applicationParticipation: {
    /* Ключ приложения-владельца. */
    readonly application: string;
    /* Исходная ревизия содержания приложения. */
    readonly revision: number;
    /* Активные реализации в порядке Core. */
    readonly items: readonly KnowledgeRecord<"implementation">[];
  };
  /* Готовность задачи по графу обязательств. */
  readonly taskProgress: TaskProgress;
  /* Независимый журнал задачи. */
  readonly taskComments: HttpTaskCollection<TaskComment>;
  /* Один неизменяемый комментарий. */
  readonly taskComment: TaskComment;
  /* Критерии и ревизия содержания задачи. */
  readonly taskCriteria: HttpTaskCollection<TaskCriterion>;
  /* Один критерий. */
  readonly taskCriterion: TaskCriterion;
  /* Прямые зависимости задачи. */
  readonly taskDependencies: HttpTaskCollection<TaskRecord>;
  /* Прямые дети задачи. */
  readonly taskChildren: readonly TaskRecord[];
  /* Необязательные связи задачи. */
  readonly taskRelated: readonly TaskRecord[];
  /* Текущие и исторические включения в планы. */
  readonly taskMemberships: TaskPlanMemberships;
  /* Готовность плана. */
  readonly planProgress: PlanProgress;
  /* Этапы плана. */
  readonly planStages: PlanStages;
  /* Один этап плана. */
  readonly planStage: PlanStageResult;
  /* Состав этапа в сохранённом порядке. */
  readonly planStageTasks: PlanStageTasks;
  /* Готовность релиза. */
  readonly releaseProgress: ReleaseProgress;
  /* Состав релиза в сохранённом порядке. */
  readonly releasePlans: ReleasePlans;
  /* Сессии в порядке Core. */
  readonly historySessions: readonly HistorySession[];
  /* Компактная хронология, незакрытые концы и границы одного generation. */
  readonly historyTimeline: HistoryTimelinePage;
  /* Окно реальных структурированных отношений без полных карточек. */
  readonly relationNeighborhood: RelationNeighborhood;
  /* Карточка сессии. */
  readonly historySession: HistorySession;
  /* Согласованный контекст сессии. */
  readonly historyContext: HistoryContext;
  /* Дерево сессий в ширину. */
  readonly historyTree: readonly HistorySession[];
  /* Открытые намерения. */
  readonly historyIntents: readonly HistoryCheckpoint[];
  /* Журнал материалов проекта либо сессии. */
  readonly historyCheckpoints: readonly HistoryCheckpoint[];
  /* Один неизменяемый материал. */
  readonly historyCheckpoint: HistoryCheckpoint;
  /* Поиск по текущим правилам Core. */
  readonly search: readonly ProjectEntity[];
  /* Групповое чтение с сохранением ошибок отдельных адресов. */
  readonly getMany: EntityReadResult;
  /* Проекция cached status Runtime. */
  readonly gitSyncStatus: HttpGitSyncStatus;
  /* Достоверный сохранённый исход либо unknown. */
  readonly gitSyncRequest: GitSyncControlOutcome;
  /* Реальные конфликты отдельно от pending dependencies. */
  readonly gitSyncConflicts: GitSyncConflictList;
  /* Стороны одного конфликта либо pending-причина. */
  readonly gitSyncConflict: GitSyncConflictDetails;
}

/**
 * Адрес самостоятельного владельца проекции.
 */
export interface HttpReferenceParameters {
  /* Постоянный ID, ключ, алиас или типизированная ссылка Core. */
  readonly ref: string;
}

/**
 * Постоянный ID вложенного объекта внутри адресованного владельца.
 */
export interface HttpNestedParameters extends HttpReferenceParameters {
  /* ID критерия либо комментария; ключ сущности сюда не подставляется. */
  readonly id: string;
}

/**
 * Постоянный ID этапа внутри адресованного плана.
 */
export interface HttpStageParameters extends HttpReferenceParameters {
  /* ID этапа, принадлежащего указанному плану. */
  readonly stageId: string;
}

/**
 * Параметры именованных проекций. Массивы query кодируются повторяющимися ключами.
 */
export interface HttpReadParameters {
  /* Окно истории; без query используется начало всего проекта. */
  readonly historyTimeline: {
    /* Параметры окна; отсутствие выбирает начало проекта. */
    readonly query?: HistoryTimelineRequest;
  };
  /* Ограниченное соседство либо окно metadata всего проекта. */
  readonly relationNeighborhood: {
    /* Параметры соседства; отсутствие выбирает начало общего каталога. */
    readonly query?: RelationNeighborhoodRequest;
  };
  /* Фильтры и исходное поколение компактной страницы задач. */
  readonly taskViews: {
    /* Текущие фильтры задач и исходное поколение продолжения. */
    readonly query: TaskViewQuery;
  };
  /* Выбор состава плана с фильтрацией доступности до окна. */
  readonly taskCandidates: {
    /* Фильтры задач и адрес редактируемого этапа, без новой семантики записи. */
    readonly query: TaskCandidateQuery;
  };
  /* Технический status выбранного проекта не принимает фильтры. */
  readonly projectStatus: Record<string, never>;
  /* Проверка целостности относится ко всему выбранному проекту. */
  readonly projectCheck: Record<string, never>;
  /* Разделы проекта не требуют ссылки. */
  readonly documentSections: Record<string, never>;
  /* Адрес документа. */
  readonly documentLinks: HttpReferenceParameters;
  /* Адрес приложения. */
  readonly applicationParticipation: HttpReferenceParameters;
  /* Адрес задачи для расчёта графа. */
  readonly taskProgress: HttpReferenceParameters;
  /* Адрес владельца журнала. */
  readonly taskComments: HttpReferenceParameters;
  /* Адрес задачи и постоянный ID комментария. */
  readonly taskComment: HttpNestedParameters;
  /* Адрес владельца критериев. */
  readonly taskCriteria: HttpReferenceParameters;
  /* Адрес задачи и постоянный ID критерия. */
  readonly taskCriterion: HttpNestedParameters;
  /* Адрес владельца зависимостей. */
  readonly taskDependencies: HttpReferenceParameters;
  /* Адрес родительской задачи. */
  readonly taskChildren: HttpReferenceParameters;
  /* Адрес владельца необязательных связей. */
  readonly taskRelated: HttpReferenceParameters;
  /* Адрес задачи для поиска включений в планы. */
  readonly taskMemberships: HttpReferenceParameters;
  /* Адрес плана. */
  readonly planProgress: HttpReferenceParameters;
  /* Адрес владельца этапов. */
  readonly planStages: HttpReferenceParameters;
  /* Адрес плана и постоянный ID этапа. */
  readonly planStage: HttpStageParameters;
  /* Адрес плана и этап состава задач. */
  readonly planStageTasks: HttpStageParameters;
  /* Адрес релиза. */
  readonly releaseProgress: HttpReferenceParameters;
  /* Адрес владельца состава планов. */
  readonly releasePlans: HttpReferenceParameters;
  /* Фильтры текущих сессий Core. */
  readonly historySessions: {
    /* Отсутствие query возвращает все сессии. */
    readonly query?: {
      /* Сохранённый статус сессии. */
      readonly status?: HistorySessionStatus;
      /* true выбирает незавершённые сессии по правилам Core. */
      readonly unfinished?: boolean;
      /* Адрес родительской сессии; несовместим с root. */
      readonly parent?: string;
      /* true передаёт parent:null; false не фильтрует состав. */
      readonly root?: boolean;
      /* Исходное авторство без нормализации. */
      readonly actor?: string;
      /* Поисковый текст сессии. */
      readonly q?: string;
    };
  };
  /* Адрес сессии. */
  readonly historySession: HttpReferenceParameters;
  /* Адрес сессии для составного контекста. */
  readonly historyContext: HttpReferenceParameters;
  /* Адрес корня дерева сессий. */
  readonly historyTree: HttpReferenceParameters;
  /* Адрес сессии и выбор глубины намерений. */
  readonly historyIntents: HttpReferenceParameters & {
    /* includeChildren=true включает дерево; отсутствие — только сама сессия. */
    readonly query?: { readonly includeChildren?: boolean };
  };
  /* Без session читается журнал всего проекта; иначе адресованной сессии. */
  readonly historyCheckpoints: { readonly query?: { readonly session?: string } };
  /* Адрес одного неизменяемого материала. */
  readonly historyCheckpoint: HttpReferenceParameters;
  /* Поиск по предметному содержанию. */
  readonly search: {
    /* Непустой поисковый запрос и необязательное ограничение вида. */
    readonly query: {
      /* Текст также рассматривается как возможный точный адрес. */
      readonly q: string;
      /* Отсутствие включает все виды. */
      readonly kind?: import("../entities/identity.types").EntityKind;
    };
  };
  /* Групповое адресное чтение одного anchor. */
  readonly getMany: {
    /* Выбор адресов и представления. */
    readonly query: {
      /* От 1 до 200 исходных адресов; порядок и повторы сохраняются. */
      readonly ref: readonly string[];
      /* true выбирает узкую SQL summary-проекцию. */
      readonly summary?: boolean;
      /* true добавляет исходные tokens успешных ID в meta.versions. */
      readonly withVersions?: boolean;
    };
  };
  /* Cached status не принимает refresh или process options от HTTP-клиента. */
  readonly gitSyncStatus: Record<string, never>;
  /* Устойчивый requestId прежнего now; не создаёт новую операцию. */
  readonly gitSyncRequest: { readonly requestId: string };
  /* Полная диагностика всех конфликтов и pending dependencies. */
  readonly gitSyncConflicts: Record<string, never>;
  /* Постоянный ID конфликтующего либо ожидающего changeset. */
  readonly gitSyncConflict: { readonly id: string };
}
