import { describe, expect, test } from "bun:test";
import {
  componentPositionBetween,
  compareComponentPositions,
  isComponentPosition,
} from "./component-position";

describe("Устойчивые плотные позиции частей", () => {
  test("вставки между неизменными соседями дают строгий порядок без перенумерации", () => {
    const left = componentPositionBetween(null, null, "left");
    const right = componentPositionBetween(left, null, "right");
    let upper = right;
    for (let index = 0; index < 100; index++) {
      const position = componentPositionBetween(left, upper, `insert-${index}`);
      expect(isComponentPosition(position)).toBe(true);
      expect(position > left && position < upper).toBe(true);
      upper = position;
    }
    expect(left < upper && upper < right).toBe(true);
  });

  test("независимые вставки в одинаковую границу стабилизируются по code-unit ID, включая prefix/Unicode", () => {
    const ids = ["aA", "a", "😀", "\uE000", "b"];
    const allocated = ids.map((id) => ({ id, position: componentPositionBetween(null, null, id) }));

    allocated.sort((a, b) => compareComponentPositions(a.position, b.position));

    expect(allocated.map((entry) => entry.id)).toEqual([...ids].sort());
    expect(new Set(allocated.map((entry) => entry.position)).size).toBe(ids.length);
  });
});
