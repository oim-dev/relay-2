import { mergeMessages } from "./merge.messages";
import { diffTextTokens, tokenizeText } from "./text-diff";
import {
  maxTextCodeUnits,
  maxTextDiffSteps,
  maxTextRefinementCodeUnits,
  maxTextTraceCells,
} from "./text-limits";
import type {
  SidedTextHunk,
  TextDiffBudget,
  TextHunk,
  TextMergeResult,
  TextTokenMode,
} from "./text.types";

/**
 * Чистое трёхстороннее объединение точных строк JS без нормализации UTF-16 или CR/LF.
 * Неизменная сторона сохраняет изменённую, одинаковые изменения применяются однократно.
 * Пересекающиеся замены, удаление против правки и разные вставки в одну позицию конфликтуют.
 * Вставка на границе замены и соседние замены независимы. Маркеры конфликта не создаются.
 *
 * Сначала выполняется построчный Myers; пересечения коротких блоков уточняются по целым
 * непробельным словам. Поэтому разные слова одной строки могут объединяться, разные
 * части одного слова — нет. Неоднозначные повторения разрешаются единым diff обеих сторон.
 *
 * Для различающихся с обеих сторон версий: сумма длин ≤ 8 388 608 единиц UTF-16, ≤ 100 000 строк
 * на версию, ≤ 2 000 000 состояний/сравнений и ≤ 262 144 ячеек трассы на весь вызов.
 * Уточнение допускает ≤ 16 384 UTF-16 суммарно на блок. Превышение даёт ok:false,
 * без усечения. Равенство версий и неизменность стороны проверяются до этих лимитов.
 * Стоимость O(S + (N + M)D + H log H), ограниченная бюджетом; память O(S + N + M + D²).
 * S — суммарная длина строк, N/M — числа токенов версий, D — расстояние редактирования,
 * H — число правок; уточнение расходует тот же общий бюджет, а его глубина не превышает 1.
 */
export function mergeText(base: string, local: string, remote: string): TextMergeResult {
  if (local === remote || remote === base) {
    return { ok: true, text: local };
  }
  if (local === base) {
    return { ok: true, text: remote };
  }
  if (base.length + local.length + remote.length > maxTextCodeUnits) {
    return { ok: false };
  }
  const budget: TextDiffBudget = { steps: maxTextDiffSteps, traceCells: maxTextTraceCells };
  return mergeTokenizedText(base, local, remote, "lines", budget);
}

/**
 * Получает оба diff в едином словаре и объединяет их, расходуя общий бюджет вызова.
 * Пословный уровень является последним: повторного уточнения конфликтов нет.
 */
function mergeTokenizedText(
  base: string,
  local: string,
  remote: string,
  mode: TextTokenMode,
  budget: TextDiffBudget,
): TextMergeResult {
  const dictionary = new Map<string, number>();
  const original = tokenizeText(base, mode, dictionary);
  const left = tokenizeText(local, mode, dictionary);
  const right = tokenizeText(remote, mode, dictionary);
  if (original === undefined || left === undefined || right === undefined) {
    return { ok: false };
  }
  const localHunks = diffTextTokens(original, left, budget);
  if (localHunks === undefined) {
    return { ok: false };
  }
  const remoteHunks = diffTextTokens(original, right, budget);
  if (remoteHunks === undefined) {
    return { ok: false };
  }
  const hunks: SidedTextHunk[] = [
    ...localHunks.map((hunk) => ({ ...hunk, side: "local" as const })),
    ...remoteHunks.map((hunk) => ({ ...hunk, side: "remote" as const })),
  ];
  hunks.sort((a, b) => a.start - b.start || a.end - b.end);
  return mergeHunkGroups(base, hunks, mode, budget);
}

/**
 * Собирает связанные пересечением группы за один проход по отсортированным правкам.
 * Нулевые диапазоны пересекаются только в одной позиции или внутри непустой замены.
 */
function mergeHunkGroups(
  base: string,
  hunks: readonly SidedTextHunk[],
  mode: TextTokenMode,
  budget: TextDiffBudget,
): TextMergeResult {
  const output: string[] = [];
  let cursor = 0;
  let index = 0;
  while (index < hunks.length) {
    const first = hunks[index];
    if (first === undefined) {
      throw new RangeError(mergeMessages.missingTextHunk);
    }
    const group = [first];
    let end = first.end;
    index++;
    while (index < hunks.length) {
      const next = hunks[index];
      if (next === undefined || !overlapsGroup(first.start, end, next)) {
        break;
      }
      group.push(next);
      end = Math.max(end, next.end);
      index++;
    }
    const merged = mergeHunkGroup(base, first.start, end, group, mode, budget);
    if (!merged.ok) {
      return merged;
    }
    output.push(base.slice(cursor, first.start), merged.text);
    cursor = end;
  }
  output.push(base.slice(cursor));
  return { ok: true, text: output.join("") };
}

/**
 * Проверяет пересечение следующей правки с диапазоном группы; смежные границы независимы.
 */
function overlapsGroup(start: number, end: number, next: TextHunk): boolean {
  return next.start < end || (start === end && next.start === start && next.end === start);
}

/**
 * Согласует один связный блок: точное равенство дедуплицируется до пословного уточнения.
 * Большой неоднозначный блок или конфликт последнего уровня возвращается без частичного текста.
 */
function mergeHunkGroup(
  base: string,
  start: number,
  end: number,
  hunks: readonly SidedTextHunk[],
  mode: TextTokenMode,
  budget: TextDiffBudget,
): TextMergeResult {
  const original = base.slice(start, end);
  const local = renderHunks(
    base,
    start,
    end,
    hunks.filter((hunk) => hunk.side === "local"),
  );
  const remote = renderHunks(
    base,
    start,
    end,
    hunks.filter((hunk) => hunk.side === "remote"),
  );
  if (local === remote || remote === original) {
    return { ok: true, text: local };
  }
  if (local === original) {
    return { ok: true, text: remote };
  }
  if (
    mode === "words" ||
    original.length + local.length + remote.length > maxTextRefinementCodeUnits
  ) {
    return { ok: false };
  }
  return mergeTokenizedText(original, local, remote, "words", budget);
}

/**
 * Применяет непересекающиеся правки одной стороны внутри блока, сохраняя точные промежутки.
 */
function renderHunks(base: string, start: number, end: number, hunks: readonly TextHunk[]): string {
  const output: string[] = [];
  let cursor = start;
  for (const hunk of hunks) {
    output.push(base.slice(cursor, hunk.start), hunk.text);
    cursor = hunk.end;
  }
  output.push(base.slice(cursor, end));
  return output.join("");
}
