import type { HistoryCheckpointData, HistoryRun, HistorySession } from "./history.types";

/**
 * Сохранённая атрибуция участия без полных причин подключения и окончания.
 */
export type HistoryTimelineRun = Omit<HistoryRun, "reason" | "endReason"> & {
  /* Сессия-владелец: ID участия имеет область нормализованного owner, не глобального каталога. */
  sessionId: string;
};

/**
 * Узкий снимок сессии, пригодный для линии и проверки авторства материалов.
 */
export interface HistoryTimelineSession extends Pick<
  HistorySession,
  "id" | "key" | "revision" | "createdAt"
> {
  /* Сохранённый заголовок. */
  title: string;
  /* Сохранённое состояние, не сетевой индикатор. */
  status: HistorySession["data"]["status"];
  /* Активное участие; null у незанятой сессии. */
  currentRunId: string | null;
  /* Настоящий родитель; null только у корня. */
  parentSessionId: string | null;
  /* Намерение родителя; null у корня. */
  originCheckpointId: string | null;
  /* Создавшее дочернюю работу участие родителя; null у корня. */
  createdByRunId: string | null;
  /* Реальное время закрытия; null у незакрытой работы. */
  closedAt: string | null;
  /* Участия в сохранённом порядке, без Markdown. */
  runs: HistoryTimelineRun[];
}

/**
 * Компактный материал без body, подробностей и снимков references.
 */
export type HistoryTimelineCheckpoint = Pick<
  HistoryCheckpointData,
  | "kind"
  | "sessionId"
  | "runId"
  | "actor"
  | "intentId"
  | "sequence"
  | "sessionRevision"
  | "title"
  | "summary"
> &
  Pick<HistorySession, "id" | "key" | "createdAt">;

/**
 * Общая идентичность производного маркера. Новые события в БД не создаются.
 */
interface TimelinePointFields {
  /* Адрес маркера: session:created/closed, session~run:started/ended либо checkpoint:checkpoint. */
  id: string;
  /* Постоянный ID линии сессии. */
  sessionId: string;
  /* Устойчивый порядковый номер маркера линии, не ревизия/sequence материала. */
  sequence: number;
  /* Сохранённое время границы либо материала. */
  at: string;
  /* Заголовок материала либо работы. */
  title: string;
  /* Только сохранённая сводка; пустая строка при её отсутствии. */
  summary: string;
  /* Непосредственный предшественник автора. */
  predecessorRunId: string | null;
}

/**
 * Материал и сохранённые границы lifecycle различаются дискриминатором.
 */
export type HistoryTimelinePoint = TimelinePointFields &
  (
    | {
        /* Материал истории. */
        kind: "checkpoint";
        /* Постоянный ID материала. */
        checkpointId: string;
        /* Сохранённый вид материала. */
        checkpointKind: HistoryCheckpointData["kind"];
        /* Обязательный автор материала. */
        runId: string;
        /* Сессия-владелец авторского участия; совпадает с sessionId материала. */
        runSessionId: string;
        /* Полное состояние intent по снимку Core; null у другого вида материала. */
        intentState: "open" | "completed" | "cancelled" | null;
      }
    | {
        /* Сохранённая временная граница, не мнимый checkpoint. */
        kind: "session-created" | "session-closed" | "run-started" | "run-ended";
        /* Авторское участие, не текущий владелец сессии; null при отсутствии участия. */
        runId: string | null;
        /* Владелец авторского участия, в том числе родитель при создании ребёнка; null без run. */
        runSessionId: string | null;
        /* Lifecycle не содержит материала. */
        checkpointId: null;
        /* Lifecycle не имеет вида материала. */
        checkpointKind: null;
        /* Lifecycle не является намерением. */
        intentState: null;
      }
  );

/**
 * Рёбра хронологии и происхождения; координаты и layout не входят в Core.
 */
export type HistoryTimelineEdge =
  | {
      /* Хронология одной сессии. */
      kind: "sequence";
      /* Предыдущий маркер. */
      from: string;
      /* Следующий маркер. */
      to: string;
    }
  | {
      /* Рождение дочерней сессии. */
      kind: "fork";
      /* Настоящий родитель. */
      fromSessionId: string;
      /* Создание ребёнка. */
      to: string;
    }
  | {
      /* Закрытие ребёнка, не принятие результата. */
      kind: "branch-end";
      /* Закрытие ребёнка. */
      from: string;
      /* Настоящий родитель. */
      toSessionId: string;
    }
  | {
      /* Начало настоящего корня. */
      kind: "root-start";
      /* Ось времени. */
      from: null;
      /* Создание корня. */
      to: string;
    }
  | {
      /* Закрытие настоящего корня. */
      kind: "root-end";
      /* Закрытие корня. */
      from: string;
      /* Ось времени. */
      to: null;
    };

/**
 * Невидимый конец хронологического ребра без полного содержания точки.
 */
export interface HistoryTimelineBoundary extends Pick<
  HistoryTimelinePoint,
  "id" | "sessionId" | "sequence" | "at" | "kind"
> {
  /* Положение относительно обратного хронологического окна. */
  side: "before" | "after";
}

/**
 * Параметры страницы; продолжение требует поколения первой страницы.
 */
export interface HistoryTimelineRequest {
  /* Необязательная ссылка одной сессии; отсутствие выбирает весь проект. */
  readonly session?: string;
  /* Смещение одновременно в точках и списке незакрытых концов; по умолчанию 0. */
  readonly offset?: number;
  /* Размер каждого окна 1..100; по умолчанию 50. */
  readonly limit?: number;
  /* Исходное поколение, обязательно при offset>0. */
  readonly generation?: number;
}

/**
 * Окно одного снимка. openEnds имеет отдельный компактный порядок: старые незакрытые
 * работы не исчезают из-за их времени вне items. Его окно использует тот же offset/limit;
 * totalOpenEnds <= total, поэтому обычное продолжение дочитывает оба состава.
 * Branches содержит только владельцев/авторов концов и цепочки предков: O(limit * depth).
 */
export interface HistoryTimelinePage {
  /* Точки окна по (at,sessionId,sequence) в обратном порядке. */
  items: HistoryTimelinePoint[];
  /* Окно последних реальных точек незакрытых сессий, по at/sessionId убыванию. */
  openEnds: HistoryTimelinePoint[];
  /* Полное число незакрытых концов до окна. */
  totalOpenEnds: number;
  /* Только требуемые заголовки и предки, без runs/Markdown. */
  branches: Omit<HistoryTimelineSession, "runs">[];
  /* Авторы точек items/openEnds и их непосредственные предшественники. */
  runs: HistoryTimelineRun[];
  /* Хронология окна, происхождение и закрытие видимых линий. */
  edges: HistoryTimelineEdge[];
  /* Все отсутствующие в items концы хронологических рёбер. */
  boundaryNodes: HistoryTimelineBoundary[];
  /* Число всех точек области. */
  total: number;
  /* Следующее окно либо null после полного чтения. */
  nextOffset: number | null;
  /* Поколение всех частей ответа. */
  generation: number;
}
