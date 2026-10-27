import type { XYPosition } from "@xyflow/react";

/**
 * Скругляет изгибы рассчитанного маршрута, не заменяя его прямой линией между карточками.
 */
export const createContextEdgePath = (points: XYPosition[]): string => {
  const start = points[0];
  if (!start) return "";
  let path = `M ${start.x} ${start.y}`;
  for (let index = 1; index < points.length; index += 1) {
    const previous = points[index - 1],
      point = points[index],
      next = points[index + 1];
    if (!previous || !point) continue;
    if (!next) {
      path += ` L ${point.x} ${point.y}`;
      continue;
    }
    const before = Math.hypot(point.x - previous.x, point.y - previous.y);
    const after = Math.hypot(next.x - point.x, next.y - point.y);
    if (before === 0 || after === 0) continue;
    const radius = Math.min(8, before / 2, after / 2);
    const entry = {
      x: point.x - ((point.x - previous.x) / before) * radius,
      y: point.y - ((point.y - previous.y) / before) * radius,
    };
    const exit = {
      x: point.x + ((next.x - point.x) / after) * radius,
      y: point.y + ((next.y - point.y) / after) * radius,
    };
    path += ` L ${entry.x} ${entry.y} Q ${point.x} ${point.y} ${exit.x} ${exit.y}`;
  }
  return path;
};
