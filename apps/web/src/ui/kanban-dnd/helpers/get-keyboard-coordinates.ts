import type { KeyboardCoordinateGetter } from "@dnd-kit/core";
import { sortableKeyboardCoordinates } from "@dnd-kit/sortable";

/**
 * Переводит горизонтальные стрелки в соседнюю колонку, а вертикальные — в обычную сортировку.
 * Отступы и ширина зоны добавления не должны делать собственную колонку соседней.
 */
export const getKeyboardCoordinates = (
  event: KeyboardEvent,
  args: Parameters<KeyboardCoordinateGetter>[1],
  statuses: string[],
): ReturnType<KeyboardCoordinateGetter> => {
  if (event.code !== "ArrowLeft" && event.code !== "ArrowRight") {
    return sortableKeyboardCoordinates(event, args);
  }
  event.preventDefault();
  const { context, active, currentCoordinates } = args;
  const source = context.droppableContainers.get(active);
  const status: unknown = context.over?.data.current?.status ?? source?.data.current?.status;
  const collision = context.collisionRect;
  if (typeof status !== "string" || collision === null) return;
  const index = statuses.indexOf(status);
  if (index < 0) return;
  const targetStatus = statuses[index + (event.code === "ArrowRight" ? 1 : -1)];
  if (targetStatus === undefined) return;
  const target = context.droppableContainers
    .getEnabled()
    .filter((container) => container.data.current?.status === targetStatus)
    .flatMap((container) => {
      const rect = context.droppableRects.get(container.id);
      return rect === undefined ? [] : [rect];
    })
    .sort(
      (left, right) => Math.abs(left.top - collision.top) - Math.abs(right.top - collision.top),
    )[0];
  if (target === undefined) return;
  return {
    x: currentCoordinates.x + target.left - collision.left,
    y: currentCoordinates.y + target.top - collision.top,
  };
};
