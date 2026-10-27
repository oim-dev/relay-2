import type { RelationDiagramFilter } from "domains/relations";

/**
 * Нормализует внешние URL-параметры до допустимой области чтения.
 */
export const readContextOptions = (
  params: URLSearchParams,
): RelationDiagramFilter & { depth: number } => {
  const direction = params.get("direction");
  const depth = Number(params.get("depth") ?? 1);
  const type = params.get("type") ?? "";
  return {
    depth: Number.isFinite(depth) ? Math.trunc(Math.max(1, Math.min(100, depth))) : 1,
    direction: direction === "incoming" || direction === "outgoing" ? direction : "both",
    type: /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(type) ? type : undefined,
  };
};
