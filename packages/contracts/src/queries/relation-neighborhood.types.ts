import type { EntityIdentity } from "../entities/entity.types";

/**
 * Постоянный адрес существующего отношения, не произвольный вид графового узла.
 */
export type RelationReference = Pick<EntityIdentity, "id" | "kind">;

/**
 * Компактная карточка узла без полного содержания.
 */
export interface RelationViewNode {
  /* Постоянный адрес. */
  ref: RelationReference;
  /* Текущий читаемый ключ. */
  key: string;
  /* Проверенное название. */
  title: string;
  /* Сохранённый статус либо пустая строка, если неприменим. */
  status: string;
  /* Ревизия содержания узла. */
  revision: number;
}

/**
 * Представление реально сохранённого структурированного поля Core.
 * Отдельная сущность-ребро и её авторство/время не выдумываются.
 */
export interface RelationViewEdge {
  /* Устойчивый производный адрес [ownerId,type,targetId,slot]. */
  id: string;
  /* Семантика поля: documents/references, depends-on, part-of и прочие текущие структуры. */
  type: string;
  /* Направление сохранённого отношения, независимо от направления обхода. */
  from: RelationReference;
  /* Существующая текущая цель. */
  to: RelationReference;
  /* Пояснение документа, название этапа плана либо пустая строка. */
  description: string;
  /* Ревизия владельца отношения, не ребра. */
  revision: number;
}

/**
 * Один кратчайший путь в выбранном направлении.
 */
export interface RelationViewPath {
  /* Адрес цели пути. */
  target: RelationReference;
  /* Адреса от корня включительно. */
  nodes: RelationReference[];
  /* Производные ID реальных отношений. */
  edges: string[];
}

/**
 * Ограниченное окно соседства; без ref возвращается окно всех узлов/отношений проекта.
 */
export interface RelationNeighborhoodRequest {
  /* true выбирает всю связную компоненту со страничным ответом без paths; по умолчанию false. */
  readonly component?: boolean;
  /* ID, ключ, алиас или типизированная ссылка, разрешаемая Core. */
  readonly ref?: string;
  /* Глубина 0..100; по умолчанию 3. */
  readonly depth?: number;
  /* Направление каждого шага; по умолчанию both. */
  readonly direction?: "both" | "incoming" | "outgoing";
  /* Ограничение типа структурированного отношения. */
  readonly type?: string;
  /* Поиск по компактным подписям, не по Markdown. */
  readonly q?: string;
  /* Смещение двух окон; по умолчанию 0. */
  readonly offset?: number;
  /* Размер каждого окна 1..100; по умолчанию 50. */
  readonly limit?: number;
  /* Исходное поколение; обязательно для offset>0. */
  readonly generation?: number;
}

/**
 * Узлы/рёбра одного snapshot; endpoints не более двух на ребро.
 * Полный проход metadata O(N+E) пока необходим для входящих связей, но не передаёт тела.
 */
export interface RelationNeighborhood {
  /* Разрешённый корень либо null у просмотра всего проекта. */
  root: RelationReference | null;
  /* Окно узлов. */
  nodes: RelationViewNode[];
  /* Окно сохранённых отношений. */
  edges: RelationViewEdge[];
  /* Концы рёбер за пределами окна узлов, без дублей. */
  endpoints: RelationViewNode[];
  /* Пути только к узлам окна. */
  paths: RelationViewPath[];
  /* Все узлы выбранной области до окна. */
  totalNodes: number;
  /* Все отношения выбранной области до окна. */
  totalEdges: number;
  /* Следующее смещение обоих окон либо null. */
  nextOffset: number | null;
  /* Узлы окна с соседями за глубиной. */
  boundary: RelationReference[];
  /* В области есть непройденные соседи, независимо от текущего окна. */
  depthLimited: boolean;
  /* Поколение всех частей ответа. */
  generation: number;
}
