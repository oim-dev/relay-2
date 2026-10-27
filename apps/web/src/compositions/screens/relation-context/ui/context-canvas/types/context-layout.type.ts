import type { XYPosition } from "@xyflow/react";
import type { ElkNode } from "elkjs/lib/elk-api";
import type { ContextPort } from "./context-flow.type";

/** Один шаг кратчайшего пути внутри отображаемого графа. */
export type ContextParent = {
  /** Предыдущая сущность на пути от корня. */
  nodeId: string;
  /** Реальная сохранённая связь этого шага. */
  edgeId: string;
};

/** План общей геометрии, не изменяющий направление или состав связей Core. */
export type ContextLayoutPlan = {
  /** Вход ELK с общими портами для узлов и линий. */
  graph: ElkNode;
  /** Ближайшие расстояния от корня по показанным связям. */
  distances: Map<string, number>;
  /** Объясняющее остовное дерево; остальные связи доступны в полном графе. */
  parents: Map<string, ContextParent>;
  /** Назначение каждого порта по его постоянному ID. */
  ports: Map<string, ContextPort>;
};

/** Геометрия одной карточки и её портов. */
export type ContextLayoutNode = {
  /** Текущие локальные координаты, включая ручной перенос. */
  position: XYPosition;
  /** Автоматические координаты, к которым относятся маршруты линий. */
  origin: XYPosition;
  /** Точки соединений, рассчитанные вместе с линиями. */
  ports: ContextPort[];
};

/** Маршрут одного ребра, включая петли и параллельные отношения. */
export type ContextLayoutEdge = {
  /** Порт начала в согласованной раскладке. */
  sourcePortId: string;
  /** Порт конца в согласованной раскладке. */
  targetPortId: string;
  /** Ломаная от from к to в общих координатах. */
  points: XYPosition[];
  /** Место краткой подписи. */
  labelPosition: XYPosition;
};

/** Один согласованный визуальный результат ELK. */
export type ContextLayout = {
  /** Карточки по постоянным адресам. */
  nodes: Map<string, ContextLayoutNode>;
  /** Геометрия рёбер текущего представления по их сохранённым ID. */
  edges: Map<string, ContextLayoutEdge>;
  /** Расстояния для объяснения последовательности чтения. */
  distances: Map<string, number>;
  /** Один объясняющий путь к каждой достижимой карточке. */
  parents: Map<string, ContextParent>;
};

/** Локальное изменение координат карточки. */
export type ContextNodeMove = {
  /** Постоянный адрес перемещаемого узла. */
  id: string;
  /** Новая позиция только в визуальном представлении. */
  position: XYPosition;
};
