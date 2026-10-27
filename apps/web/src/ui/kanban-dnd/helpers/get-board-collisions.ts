import { closestCorners, pointerWithin, rectIntersection } from "@dnd-kit/core";
import type { CollisionDetection } from "@dnd-kit/core";
import { isNonEmptyArray } from "shared/value-predicates";

/**
 * Выбирает область под указателем, в том числе пустой хвост длинной колонки.
 * Для клавиатуры использует пересечение карточки с целевой областью.
 */
export const getBoardCollisions: CollisionDetection = (args) => {
  const pointed = pointerWithin(args);
  if (isNonEmptyArray(pointed)) return pointed;
  const intersected = rectIntersection(args);
  if (isNonEmptyArray(intersected)) return intersected;
  return closestCorners(args);
};
