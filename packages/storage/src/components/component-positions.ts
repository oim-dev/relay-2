import {
  componentPositionBetween,
  compareComponentPositions,
  type PortableComponent,
} from "@relay/contracts";

/**
 * Выбирает наибольшую неизменяемую подпоследовательность старого порядка за O(n log n).
 * Только новые/перемещённые элементы получают позиции; вставка не меняет соседей.
 */
function retainedPositions(
  ids: readonly string[],
  previous: ReadonlyMap<string, string>,
): Set<string> {
  const ordered = [...previous].sort(
    (a, b) => compareComponentPositions(a[1], b[1]) || compareComponentPositions(a[0], b[0]),
  );
  const indexes = new Map(ordered.map(([id], index) => [id, index]));
  const sequence = ids.flatMap((id) => {
    const index = indexes.get(id);
    return index === undefined ? [] : [{ id, index }];
  });
  const tails: number[] = [];
  const predecessors = new Map<number, number>();
  for (let index = 0; index < sequence.length; index++) {
    const value = sequence[index];
    if (value === undefined) {
      continue;
    }
    let low = 0;
    let high = tails.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      const tail = tails[middle];
      if (tail !== undefined && (sequence[tail]?.index ?? -1) < value.index) {
        low = middle + 1;
      } else {
        high = middle;
      }
    }
    if (low > 0) {
      predecessors.set(index, tails[low - 1] ?? -1);
    }
    tails[low] = index;
  }
  const retained = new Set<string>();
  let cursor = tails.at(-1) ?? -1;
  while (cursor >= 0) {
    const entry = sequence[cursor];
    if (entry !== undefined) {
      retained.add(entry.id);
    }
    cursor = predecessors.get(cursor) ?? -1;
  }
  return retained;
}

/**
 * Назначает позиции одного owner/kind/group, сохраняя все неизменённые anchors.
 */
export function assignComponentPositions(
  ids: readonly string[],
  previous: readonly PortableComponent[],
): ReadonlyMap<string, string> {
  const old = new Map(
    previous.filter((part) => !part.deleted).map((part) => [part.id, part.position]),
  );
  const retained = retainedPositions(ids, old);
  const result = new Map<string, string>();
  let left: string | null = null;
  for (let index = 0; index < ids.length; index++) {
    const id = ids[index];
    if (id === undefined) {
      continue;
    }
    const current = old.get(id);
    if (retained.has(id) && current !== undefined && (left === null || left < current)) {
      result.set(id, current);
      left = current;
      continue;
    }
    let right: string | null = null;
    for (let next = index + 1; next < ids.length; next++) {
      const candidate = ids[next];
      if (candidate !== undefined && retained.has(candidate)) {
        const position = old.get(candidate);
        if (position !== undefined && (left === null || position > left)) {
          right = position;
          break;
        }
      }
    }
    left = componentPositionBetween(left, right, id);
    result.set(id, left);
  }
  return result;
}
