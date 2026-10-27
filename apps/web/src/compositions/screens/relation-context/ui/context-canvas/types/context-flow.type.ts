import type { Node, Edge, Position, XYPosition } from "@xyflow/react";
import type { RelationNode } from "domains/relations";

/** Один визуальный порт сохранённого отношения. */
export type ContextPort = {
  /** ID отношения с ролью конца. */
  id: string;
  /** Сторона направления отношения. */
  type: "source" | "target";
  /** Сторона карточки, согласованная с маршрутом линии. */
  position: Position;
  /** Координата порта относительно левого края карточки. */
  x: number;
  /** Координата порта относительно верхнего края карточки. */
  y: number;
};

/** Карточка диаграммы с отдельно заданными точками подключения. */
export type ContextFlowNode = Node<
  {
    /** Сохранённая краткая запись. */
    entity: RelationNode;
    /** Исходная сущность просмотра. */
    isRoot: boolean;
    /** Есть непройденное окружение. */
    isBoundary: boolean;
    /** Минимальное расстояние по показанным связям; null для пока несоединённой области. */
    distance: number | null;
    /** Карточка за пределами выбранного пути и непосредственного окружения. */
    isDimmed: boolean;
    /** Число отношений вне основного дерева, включая повторные пути и циклы. */
    additionalCount: number;
    /** Число сохранённых петель этой сущности. */
    loopCount: number;
    /** Порты позволяют различать параллельные отношения. */
    ports: ContextPort[];
  },
  "context"
>;

/** Отдельная линия для каждого ID связи Core. */
export type ContextFlowEdge = Edge<
  {
    /** Все изгибы согласованного маршрута ELK. */
    points: XYPosition[];
    /** Позиция подписи в свободной части линии. */
    labelPosition: XYPosition;
    /** Карточка вручную сдвинута относительно автоматической раскладки. */
    hasManualPosition: boolean;
    /** Показывать подпись только в фокусе исследования. */
    hasLabel: boolean;
    /** Русское или расширенное техническое имя отношения. */
    title: string;
  },
  "context"
>;
