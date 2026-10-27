import type { ComponentPropsWithoutRef } from "react";
import type { RelationNode, RelationEdge } from "domains/relations";

/** Все загруженные отношения выбранной сущности, включая скрытые в дереве линии. */
export type ContextNodeRelationsParams = {
  /** Постоянный адрес выбранной сущности. */
  address: string;
  /** Карточки для подписей концов отношений. */
  nodes: RelationNode[];
  /** Сохранённые отношения загруженного снимка. */
  edges: RelationEdge[];
  /** Открывает подробности конкретной связи по её ID. */
  onSelect: (edgeId: string) => void;
};
/** Атрибуты корневого элемента. */
type RootAttrs = Omit<ComponentPropsWithoutRef<"section">, "children" | "onSelect">;
/** Свойства списка с ограниченным отображением и продолжением. */
export type ContextNodeRelationsProps = RootAttrs & ContextNodeRelationsParams;
