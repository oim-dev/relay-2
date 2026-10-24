import { describe, expect, test } from "bun:test";
import { mergeOrder } from "./order";

const compatibleCases = [
  {
    name: "пустой согласованный состав остаётся пустым",
    base: ["A"],
    local: [],
    remote: ["A"],
    members: [],
    expected: [],
  },
  {
    name: "исходный порядок не заменяется лексикографической сортировкой",
    base: ["C", "A", "B"],
    local: ["C", "A", "B"],
    remote: ["C", "A", "B"],
    members: ["B", "C", "A"],
    expected: ["C", "A", "B"],
  },
  {
    name: "изменённый порядок сильнее неизменной стороны",
    base: ["A", "B", "C", "D"],
    local: ["D", "A", "B", "C"],
    remote: ["A", "B", "C", "D"],
    members: ["A", "B", "C", "D"],
    expected: ["D", "A", "B", "C"],
  },
  {
    name: "одинаковые перемещения согласуются однократно",
    base: ["A", "B", "C", "D"],
    local: ["A", "D", "B", "C"],
    remote: ["A", "D", "B", "C"],
    members: ["A", "B", "C", "D"],
    expected: ["A", "D", "B", "C"],
  },
  {
    name: "независимые перестановки двух пар сохраняются обе",
    base: ["A", "B", "C", "D"],
    local: ["B", "A", "C", "D"],
    remote: ["A", "B", "D", "C"],
    members: ["A", "B", "C", "D"],
    expected: ["B", "A", "D", "C"],
  },
  {
    name: "независимые вставки X и Y между A и B получают порядок X перед Y",
    base: ["A", "B"],
    local: ["A", "X", "B"],
    remote: ["A", "Y", "B"],
    members: ["Y", "B", "X", "A"],
    expected: ["A", "X", "Y", "B"],
  },
  {
    name: "общая вставка не дублируется рядом с независимыми новыми ID",
    base: ["A", "B"],
    local: ["A", "X", "Z", "B"],
    remote: ["A", "X", "Y", "B"],
    members: ["A", "X", "Z", "Y", "B"],
    expected: ["A", "X", "Y", "Z", "B"],
  },
  {
    name: "связанный порядок новых ID сильнее их лексикографических имён",
    base: [],
    local: ["z", "a"],
    remote: ["m", "b"],
    members: ["a", "b", "m", "z"],
    expected: ["m", "b", "z", "a"],
  },
  {
    name: "tie использует UTF-16 code units, а не locale или Unicode code points",
    base: ["start", "end"],
    local: ["start", "\ue000", "end"],
    remote: ["start", "😀", "end"],
    members: ["end", "\ue000", "😀", "start"],
    expected: ["start", "😀", "\ue000", "end"],
  },
  {
    name: "снятый ID не воскресает из устаревшей стороны и не мешает перестановке",
    base: ["A", "B", "C", "D"],
    local: ["A", "C", "D"],
    remote: ["A", "B", "D", "C"],
    members: ["A", "C", "D"],
    expected: ["A", "D", "C"],
  },
  {
    name: "отсутствующий на одной стороне ID остаётся при уже согласованном составе",
    base: ["A", "B", "C"],
    local: ["A", "C"],
    remote: ["A", "B", "C"],
    members: ["A", "B", "C"],
    expected: ["A", "B", "C"],
  },
  {
    name: "исключённый из состава новый ID игнорируется",
    base: ["A", "B"],
    local: ["A", "X", "B"],
    remote: ["A", "B"],
    members: ["A", "B"],
    expected: ["A", "B"],
  },
  {
    name: "перемещение старых ID объединяется с независимой вставкой в другой части",
    base: ["A", "B", "C", "D"],
    local: ["B", "A", "C", "D"],
    remote: ["A", "B", "C", "X", "D"],
    members: ["A", "B", "C", "D", "X"],
    expected: ["B", "A", "C", "X", "D"],
  },
  {
    name: "независимые перемещения не конфликтуют из-за разных затронутых пар одного соседа",
    base: ["A", "B", "C", "D"],
    local: ["B", "C", "D", "A"],
    remote: ["A", "C", "B", "D"],
    members: ["A", "B", "C", "D"],
    expected: ["C", "B", "D", "A"],
  },
  {
    name: "вставки перед началом и после конца сохраняют якоря",
    base: ["B", "A"],
    local: ["Z", "B", "A"],
    remote: ["B", "A", "X"],
    members: ["A", "B", "X", "Z"],
    expected: ["Z", "B", "A", "X"],
  },
] as const;

const conflictingCases = [
  {
    name: "перемещения создают цикл B перед A перед C перед B",
    base: ["A", "B", "C"],
    local: ["B", "A", "C"],
    remote: ["A", "C", "B"],
    members: ["A", "B", "C"],
  },
  {
    name: "разные цели перемещения B конфликтуют даже без цикла итоговых инверсий",
    base: ["A", "B", "C", "D", "E"],
    local: ["A", "C", "B", "D", "E"],
    remote: ["A", "C", "D", "B", "E"],
    members: ["A", "B", "C", "D", "E"],
  },
  {
    name: "одинаковый новый ID в разных позициях конфликтует",
    base: ["A", "B", "C"],
    local: ["A", "X", "B", "C"],
    remote: ["A", "B", "X", "C"],
    members: ["A", "B", "C", "X"],
  },
  {
    name: "противоположный порядок двух общих новых ID конфликтует",
    base: [],
    local: ["X", "Y"],
    remote: ["Y", "X"],
    members: ["X", "Y"],
  },
  {
    name: "вставка с якорями, противоречащими перемещению, создаёт конфликт порядка",
    base: ["A", "B"],
    local: ["B", "A"],
    remote: ["A", "X", "B"],
    members: ["A", "B", "X"],
  },
  {
    name: "неизвестный surviving ID не добавляется произвольно",
    base: ["A"],
    local: ["A"],
    remote: ["A"],
    members: ["A", "missing"],
  },
  {
    name: "потерянный обеими сторонами surviving ID не восстанавливается из base",
    base: ["A", "B"],
    local: ["A"],
    remote: ["A"],
    members: ["A", "B"],
  },
  {
    name: "дубликат в base отклоняется даже для исключённого ID",
    base: ["A", "B", "B"],
    local: ["A"],
    remote: ["A"],
    members: ["A"],
  },
  {
    name: "дубликат в local отклоняется",
    base: ["A", "B"],
    local: ["A", "B", "A"],
    remote: ["A", "B"],
    members: ["A", "B"],
  },
  {
    name: "дубликат в remote отклоняется",
    base: ["A", "B"],
    local: ["A", "B"],
    remote: ["A", "A", "B"],
    members: ["A", "B"],
  },
  {
    name: "дубликат в members отклоняется",
    base: ["A", "B"],
    local: ["A", "B"],
    remote: ["A", "B"],
    members: ["A", "B", "A"],
  },
] as const;

describe("Трёхстороннее согласование порядка", () => {
  test.each(compatibleCases)("$name", ({ base, local, remote, members, expected }) => {
    const result = mergeOrder(base, local, remote, members);
    const reversed = mergeOrder(base, remote, local, members);

    expect(result).toEqual({ ok: true, items: expected });
    expect(reversed).toEqual({ ok: true, items: expected });
  });

  test.each(conflictingCases)("$name", ({ base, local, remote, members }) => {
    const result = mergeOrder(base, local, remote, members);
    const reversed = mergeOrder(base, remote, local, members);

    expect(result).toEqual({ ok: false });
    expect(reversed).toEqual({ ok: false });
  });

  test("успешное объединение не меняет замороженные входные массивы", () => {
    const base = Object.freeze(["A", "B"]);
    const local = Object.freeze(["A", "X", "B"]);
    const remote = Object.freeze(["A", "Y", "B"]);
    const members = Object.freeze(["B", "Y", "A", "X"]);

    const result = mergeOrder(base, local, remote, members);

    expect(result).toEqual({ ok: true, items: ["A", "X", "Y", "B"] });
    expect(base).toEqual(["A", "B"]);
    expect(local).toEqual(["A", "X", "B"]);
    expect(remote).toEqual(["A", "Y", "B"]);
    expect(members).toEqual(["B", "Y", "A", "X"]);
  });

  test("конфликт не меняет замороженные входные массивы и не возвращает частичный порядок", () => {
    const base = Object.freeze(["A", "B", "C"]);
    const local = Object.freeze(["B", "A", "C"]);
    const remote = Object.freeze(["A", "C", "B"]);
    const members = Object.freeze(["C", "B", "A"]);

    const result = mergeOrder(base, local, remote, members);

    expect(result).toEqual({ ok: false });
    expect(base).toEqual(["A", "B", "C"]);
    expect(local).toEqual(["B", "A", "C"]);
    expect(remote).toEqual(["A", "C", "B"]);
    expect(members).toEqual(["C", "B", "A"]);
  });

  test("превышение предела surviving ID возвращает отказ до обхода пар", () => {
    const members = Array.from({ length: 4_097 }, (_, index) => `id-${index}`);

    const result = mergeOrder(members, members, members, members);

    expect(result).toEqual({ ok: false });
  });

  test("слишком большой вход отклоняется даже при пустом согласованном составе", () => {
    const base = Array.from({ length: 100_001 }, (_, index) => `removed-${index}`);

    const result = mergeOrder(base, [], [], []);

    expect(result).toEqual({ ok: false });
  });
});
