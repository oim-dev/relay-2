import { mergeMessages } from "./merge.messages";
import { maxTextTokens } from "./text-limits";
import type { TextDiffBudget, TextHunk, TextTokenMode, TextTokens, TokenEdit } from "./text.types";

/**
 * Разбивает точную строку без декодирования Unicode и интернирует токены в общем словаре.
 * Слова неделимы: это максимальные непробельные участки, включая пунктуацию и суррогаты.
 * Изменяет только переданный внутренний словарь; undefined означает превышение числа токенов.
 */
export function tokenizeText(
  text: string,
  mode: TextTokenMode,
  dictionary: Map<string, number>,
): TextTokens | undefined {
  const pattern = mode === "lines" ? /[^\n]*\n|[^\n]+$/g : /\r\n|[^\S\r\n]+|[\r\n]|[^\s]+/gu;
  const keys: number[] = [];
  const offsets = [0];
  for (const match of text.matchAll(pattern)) {
    if (keys.length === maxTextTokens) {
      return undefined;
    }
    const token = match[0];
    let key = dictionary.get(token);
    if (key === undefined) {
      key = dictionary.size;
      dictionary.set(token, key);
    }
    keys.push(key);
    offsets.push(match.index + token.length);
  }
  return { text, keys, offsets };
}

/**
 * Вычисляет кратчайший построчный или пословный diff Myers с общим ограниченным бюджетом.
 * Общие префикс/суффикс исключаются до поиска. undefined означает исчерпание бюджета.
 * Входные токены не изменяются; расходуются только счётчики внутреннего budget.
 */
export function diffTextTokens(
  base: TextTokens,
  next: TextTokens,
  budget: TextDiffBudget,
): readonly TextHunk[] | undefined {
  let prefix = 0;
  while (prefix < Math.min(base.keys.length, next.keys.length)) {
    if (--budget.steps < 0) {
      return undefined;
    }
    if (base.keys[prefix] !== next.keys[prefix]) {
      break;
    }
    prefix++;
  }
  let baseEnd = base.keys.length;
  let nextEnd = next.keys.length;
  while (baseEnd > prefix && nextEnd > prefix) {
    if (--budget.steps < 0) {
      return undefined;
    }
    if (base.keys[baseEnd - 1] !== next.keys[nextEnd - 1]) {
      break;
    }
    baseEnd--;
    nextEnd--;
  }
  if (prefix === baseEnd && prefix === nextEnd) {
    return [];
  }
  if (prefix === baseEnd || prefix === nextEnd) {
    return editsToHunks(base, next, [{ start: prefix, end: baseEnd, nextStart: prefix, nextEnd }]);
  }
  const trace = findTrace(
    base.keys.slice(prefix, baseEnd),
    next.keys.slice(prefix, nextEnd),
    budget,
  );
  if (trace === undefined) {
    return undefined;
  }
  const edits = backtrackEdits(baseEnd - prefix, nextEnd - prefix, trace, prefix);
  return editsToHunks(base, next, edits);
}

/**
 * Ищет ограниченную трассу Myers по числовым ключам, не сравнивая длинные строки повторно.
 * Каждая строка трассы содержит d + 1 достижимых диагоналей; -1 обозначает недостижимость.
 */
function findTrace(
  base: readonly number[],
  next: readonly number[],
  budget: TextDiffBudget,
): readonly Int32Array[] | undefined {
  const trace: Int32Array[] = [];
  let previous = new Int32Array();
  for (let distance = 0; distance <= base.length + next.length; distance++) {
    if (distance + 1 > budget.traceCells || distance + 1 > budget.steps) {
      return undefined;
    }
    budget.traceCells -= distance + 1;
    budget.steps -= distance + 1;
    const row = new Int32Array(distance + 1).fill(-1);
    trace.push(row);
    for (let index = 0; index <= distance; index++) {
      const down = takeInsertion(previous, index);
      const predecessor = down ? (previous[index] ?? -1) : (previous[index - 1] ?? -1);
      let x = distance === 0 ? 0 : predecessor + (down ? 0 : 1);
      let y = x - (-distance + 2 * index);
      if ((distance > 0 && predecessor < 0) || x > base.length || y < 0 || y > next.length) {
        continue;
      }
      while (x < base.length && y < next.length) {
        if (--budget.steps < 0) {
          return undefined;
        }
        if (base[x] !== next[y]) {
          break;
        }
        x++;
        y++;
      }
      row[index] = x;
      if (x === base.length && y === next.length) {
        return trace;
      }
    }
    previous = row;
  }
  return undefined;
}

/**
 * Выбирает предшественника диагонали Myers; при равенстве предпочтительно удаление.
 * За границами предыдущей строки находится недостижимая диагональ со значением -1.
 */
function takeInsertion(previous: Int32Array, index: number): boolean {
  return (
    index === 0 ||
    (index < previous.length && (previous[index - 1] ?? -1) < (previous[index] ?? -1))
  );
}

/**
 * Восстанавливает только вставки и удаления, пропуская совпавшие участки за O(N + D).
 * prefix переводит координаты сокращённой трассы в координаты исходных токенов.
 */
function backtrackEdits(
  baseLength: number,
  nextLength: number,
  trace: readonly Int32Array[],
  prefix: number,
): readonly TokenEdit[] {
  const edits: TokenEdit[] = [];
  let x = baseLength;
  let y = nextLength;
  for (let distance = trace.length - 1; distance > 0; distance--) {
    const previous = trace[distance - 1];
    // Строка существует: distance убывает от последней строки непустой трассы до 1.
    if (previous === undefined) {
      throw new RangeError(mergeMessages.missingMyersTraceRow);
    }
    const index = (x - y + distance) / 2;
    const down = takeInsertion(previous, index);
    const previousX = down ? (previous[index] ?? -1) : (previous[index - 1] ?? -1);
    const previousY = previousX - (x - y + (down ? 1 : -1));
    const snakeLength = Math.min(x - previousX, y - previousY);
    x -= snakeLength;
    y -= snakeLength;
    if (down) {
      edits.push({
        start: x + prefix,
        end: x + prefix,
        nextStart: y - 1 + prefix,
        nextEnd: y + prefix,
      });
      y--;
    } else {
      edits.push({
        start: x - 1 + prefix,
        end: x + prefix,
        nextStart: y + prefix,
        nextEnd: y + prefix,
      });
      x--;
    }
  }
  return edits.reverse();
}

/**
 * Склеивает соседние элементарные операции в точные замены UTF-16 без нормализации текста.
 * Отсутствующая граница означает нарушение внутренней целостности, а не пустую замену.
 */
function editsToHunks(
  base: TextTokens,
  next: TextTokens,
  edits: readonly TokenEdit[],
): readonly TextHunk[] {
  const grouped: TokenEdit[] = [];
  for (const edit of edits) {
    const last = grouped.at(-1);
    if (last !== undefined && last.end === edit.start && last.nextEnd === edit.nextStart) {
      grouped[grouped.length - 1] = { ...last, end: edit.end, nextEnd: edit.nextEnd };
    } else {
      grouped.push(edit);
    }
  }
  return grouped.map((edit) => {
    const start = base.offsets[edit.start];
    const end = base.offsets[edit.end];
    const nextStart = next.offsets[edit.nextStart];
    const nextEnd = next.offsets[edit.nextEnd];
    if (
      start === undefined ||
      end === undefined ||
      nextStart === undefined ||
      nextEnd === undefined
    ) {
      throw new RangeError(mergeMessages.missingTextTokenOffset);
    }
    return { start, end, text: next.text.slice(nextStart, nextEnd) };
  });
}
