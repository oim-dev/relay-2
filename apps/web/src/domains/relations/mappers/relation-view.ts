import type { NamedCommand, RelationNeighborhood, RelationViewEdge } from "@relay/contracts";
import type { RelationsPage } from "../types/relations.type";

/**
 * Подключает только поддерживаемую кнопку отзыва; допустимость команды проверяет Core.
 * Guard принадлежит исходной сущности, а не отдельному ребру.
 */
function removal(edge: RelationViewEdge): NamedCommand | null {
  const base = { ref: edge.from.id, ifRevision: edge.revision };
  if (edge.from.kind === "document" && (edge.type === "documents" || edge.type === "references")) {
    return { ...base, op: "document.unlink", input: { target: edge.to.id, type: edge.type } };
  }
  if (
    edge.from.kind === "task" &&
    edge.to.kind === "task" &&
    (edge.type === "depends-on" || edge.type === "related")
  ) {
    return {
      ...base,
      op: edge.type === "depends-on" ? "task.dependency.remove" : "task.unlink",
      input: { target: edge.to.id },
    };
  }
  return null;
}

/**
 * Сохраняет DTO текущей проекции и добавляет только возможности существующего renderer.
 */
export function relationView(page: RelationNeighborhood): RelationsPage {
  return {
    ...page,
    version: String(page.generation),
    edges: page.edges.map((edge) => ({ ...edge, source: "structured", remove: removal(edge) })),
  };
}
