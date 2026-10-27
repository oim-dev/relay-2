import type {
  HistoryCheckpoint,
  HistoryRun,
  HistorySession,
  HistoryTimelinePoint,
  HistoryTimelineRun,
  HistoryTimelineEdge,
  HistoryTimelineBoundary,
  HistoryTimelineSession,
} from "@relay/contracts";

/**
 * Компактная атрибуция текущего Core, достаточная для аватара/подсказки.
 */
export type WorkGraphRun = Omit<HistoryTimelineRun, "id"> & {
  /* Локальный ключ renderer [sessionId, rawId], а не предметный ID участия. */
  id: string;
  /* Исходный постоянный ID участия внутри сессии. */
  rawId: string;
};
/**
 * Локальные подсказки renderer поверх заголовка Core, без вычисления состояний.
 */
export type WorkGraphBranch = Omit<HistoryTimelineSession, "runs"> & {
  /* У Relay2 нет legacy parentSequence. */
  parentSequence: null;
  /* Линия нужна контексту окна. */
  contextOnly: boolean;
};
/**
 * Точка renderer: авторские ID заменены scoped ключами его таблицы runs; остальные поля Core.
 */
export type WorkGraphPoint = HistoryTimelinePoint;
/**
 * Хронология и происхождение без координат.
 */
export type WorkGraphEdge = HistoryTimelineEdge;
/**
 * Граница окна; outside-scope зарезервирована локальным renderer.
 */
export type WorkGraphBoundary = Omit<HistoryTimelineBoundary, "side"> & {
  side: "before" | "after" | "outside-scope";
};

/**
 * Страница в форме существующего renderer; version — строковый generation.
 */
export interface WorkHistoryGraphPage {
  /* Исходное смещение для проверки непрерывности страниц. */
  offset: number;
  /* Компактные точки окна. */
  items: WorkGraphPoint[];
  /* Окно реальных незакрытых концов. */
  openEnds: WorkGraphPoint[];
  /* Заголовки владельцев и предков. */
  branches: WorkGraphBranch[];
  /* Авторы и непосредственные предшественники. */
  runs: WorkGraphRun[];
  /* Сохранённая хронология и происхождение. */
  edges: WorkGraphEdge[];
  /* Невидимые концы рёбер. */
  boundaryNodes: WorkGraphBoundary[];
  /* Полное число точек области. */
  total: number;
  /* Продолжение либо null. */
  nextOffset: number | null;
  /* Поколение всех частей. */
  version: string;
}

/**
 * Полные данные только открытой точки, независимо от компактного графа.
 */
export interface WorkGraphPointDetail {
  /* Выбранная реальная граница/материал. */
  point: HistoryTimelinePoint;
  /* Полная сессия; nullable тексты представлены пустой строкой для Markdown renderer. */
  session: Omit<HistorySession["data"], "description" | "result"> &
    Pick<HistorySession, "id" | "key"> & { description: string; result: string };
  /* Полный автор выбранной точки. */
  run: HistoryRun | null;
  /* Сохранённый предшественник автора. */
  previousRun: HistoryRun | null;
  /* Полный выбранный материал либо null у lifecycle. */
  checkpoint: (HistoryCheckpoint["data"] & Pick<HistoryCheckpoint, "id" | "key">) | null;
}

/**
 * Непрерывный префикс страниц одного поколения.
 */
export type WorkGraph = Omit<WorkHistoryGraphPage, "offset" | "nextOffset">;
/**
 * Состояния чтения существующего renderer.
 */
export interface WorkGraphState {
  /* Прежний граф сохраняется при отказе. */
  graph: WorkGraph | null;
  /* Текущий reader поддерживается SDK. */
  isSupported: boolean | undefined;
  /* Первое чтение. */
  isLoading: boolean;
  /* Любое чтение. */
  isRefreshing: boolean;
  /* Есть непрочитанная страница. */
  hasMore: boolean;
  /* Отказ чтения, не пустая история. */
  error: Error | undefined;
  /* Начать с нового поколения. */
  refresh: () => void;
  /* Продолжить исходное поколение. */
  loadMore: () => void;
}
