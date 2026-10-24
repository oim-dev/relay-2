import { mergeMessages } from "./merge.messages";
import type { OrderMergeResult, OrderNode, OrderRelation } from "./order.types";

/**
 * Предел surviving ID ограничивает квадратичное число сравнений неявного графа.
 */
const maxOrderMembers = 4_096;

/**
 * Предел суммарного числа входных ID, включая снятые элементы и members.
 */
const maxOrderInputItems = 100_000;

/**
 * Согласует относительный порядок base/local/remote для уже выбранного состава members.
 * Состав не пересчитывается: снятые ID игнорируются, каждый surviving ID должен встречаться
 * хотя бы в local или remote. Отсутствие на одной стороне не создаёт ограничения её порядка.
 * Дубли в любом из четырёх массивов, неизвестный surviving ID и потеря ID обеими сторонами
 * дают ok:false. Проверка дублей включает также ID, исключённые из members.
 *
 * Для старой пары применяется инверсия относительно base, внесённая хотя бы одной стороной;
 * неизменная пара сохраняет base. Новые пары используют известные позиции обеих сторон:
 * противоречие конфликтует, отсутствие общей позиции разрешается по UTF-16 code-unit ID.
 * Если обе стороны начали одно перемещение (общая инверсия с этим ID), разные наборы
 * инверсий данного ID считаются разными целями перемещения и тоже конфликтуют.
 * Остальные противоречия выявляются как циклы; сортировка ID не заменяет ограничения.
 *
 * Входные массивы не изменяются. Время O(I + V² + V log V), память O(I + V), без матрицы
 * пар: I — суммарное число входных ID, V — размер members. Стоимость строковых сравнений
 * дополнительно зависит от длины ID. Лимиты I ≤ 100 000 и V ≤ 4 096; превышение — ok:false.
 */
export function mergeOrder(
  base: readonly string[],
  local: readonly string[],
  remote: readonly string[],
  members: readonly string[],
): OrderMergeResult {
  if (
    members.length > maxOrderMembers ||
    base.length + local.length + remote.length + members.length > maxOrderInputItems
  ) {
    return { ok: false };
  }
  const original = indexPositions(base);
  const left = indexPositions(local);
  const right = indexPositions(remote);
  const selected = indexPositions(members);
  if (
    original === undefined ||
    left === undefined ||
    right === undefined ||
    selected === undefined
  ) {
    return { ok: false };
  }
  const nodes: OrderNode[] = [...members].sort(compareIds).map((id) => ({
    id,
    base: original.get(id),
    local: left.get(id),
    remote: right.get(id),
    incoming: 0,
    localReversals: 0,
    remoteReversals: 0,
    sharedReversals: 0,
    emitted: false,
  }));
  if (nodes.some((node) => node.local === undefined && node.remote === undefined)) {
    return { ok: false };
  }
  if (!initializeConstraints(nodes) || nodes.some(hasCompetingMove)) {
    return { ok: false };
  }
  return topologicalOrder(nodes);
}

/**
 * Строит позиции ID, отвергая дубли до фильтрации состава; вход не изменяется.
 */
function indexPositions(items: readonly string[]): ReadonlyMap<string, number> | undefined {
  const result = new Map<string, number>();
  for (const [index, id] of items.entries()) {
    if (result.has(id)) {
      return undefined;
    }
    result.set(id, index);
  }
  return result;
}

/**
 * Сравнивает ID по кодовым единицам UTF-16 независимо от locale и порядка аргументов merge.
 */
function compareIds(left: string, right: string): number {
  if (left === right) {
    return 0;
  }
  return left < right ? -1 : 1;
}

/**
 * Возвращает известную относительную позицию; отсутствие любого ID не задаёт отношение пары.
 */
function relativePosition(left: number | undefined, right: number | undefined): -1 | 0 | 1 {
  if (left === undefined || right === undefined) {
    return 0;
  }
  return left < right ? -1 : 1;
}

/**
 * Вычисляет одно ограничение неявного графа без выделения объекта ребра.
 * Изменённое отношение старой пары сильнее неизменного, новые пары требуют согласия сторон.
 */
function compareNodes(left: OrderNode, right: OrderNode): OrderRelation {
  const base = relativePosition(left.base, right.base);
  const local = relativePosition(left.local, right.local);
  const remote = relativePosition(left.remote, right.remote);
  if (base !== 0) {
    if ((local !== 0 && local !== base) || (remote !== 0 && remote !== base)) {
      return base === -1 ? 1 : -1;
    }
    return base;
  }
  if (local !== 0 && remote !== 0 && local !== remote) {
    return "conflict";
  }
  return local === 0 ? remote : local;
}

/**
 * Считает входящие рёбра и инверсии за один обход пар, изменяя только собственные узлы.
 * Граф остаётся неявным: память не зависит от количества пар.
 */
function initializeConstraints(nodes: readonly OrderNode[]): boolean {
  for (const [index, left] of nodes.entries()) {
    for (let rightIndex = index + 1; rightIndex < nodes.length; rightIndex++) {
      const right = nodes[rightIndex];
      if (right === undefined) {
        throw new RangeError(mergeMessages.missingOrderNode);
      }
      const relation = compareNodes(left, right);
      if (relation === "conflict") {
        return false;
      }
      if (relation === -1) {
        right.incoming++;
      } else if (relation === 1) {
        left.incoming++;
      }
      countReversals(left, right);
    }
  }
  return true;
}

/**
 * Учитывает инверсию старой пары у обоих участников; отсутствующая сторона не считается ходом.
 */
function countReversals(left: OrderNode, right: OrderNode): void {
  const base = relativePosition(left.base, right.base);
  if (base === 0) {
    return;
  }
  const local = relativePosition(left.local, right.local);
  const remote = relativePosition(left.remote, right.remote);
  const localChanged = local !== 0 && local !== base;
  const remoteChanged = remote !== 0 && remote !== base;
  if (localChanged) {
    left.localReversals++;
    right.localReversals++;
  }
  if (remoteChanged) {
    left.remoteReversals++;
    right.remoteReversals++;
  }
  if (localChanged && remoteChanged) {
    left.sharedReversals++;
    right.sharedReversals++;
  }
}

/**
 * Выявляет разные цели общего перемещения; одинаковая часть не скрывает лишние инверсии.
 */
function hasCompetingMove(node: OrderNode): boolean {
  return (
    node.sharedReversals > 0 &&
    (node.sharedReversals !== node.localReversals || node.sharedReversals !== node.remoteReversals)
  );
}

/**
 * Выдаёт топологический порядок, при равной готовности выбирая минимальный UTF-16 ID.
 * Пересчитывает исходящие рёбра по позициям, не сохраняя квадратичный список смежности.
 * Непосещённый остаток без готовых узлов означает цикл и возвращается только как отказ.
 */
function topologicalOrder(nodes: readonly OrderNode[]): OrderMergeResult {
  const items: string[] = [];
  while (items.length < nodes.length) {
    const ready = nodes.find((node) => !node.emitted && node.incoming === 0);
    if (ready === undefined) {
      return { ok: false };
    }
    ready.emitted = true;
    items.push(ready.id);
    for (const node of nodes) {
      if (!node.emitted && compareNodes(ready, node) === -1) {
        node.incoming--;
      }
    }
  }
  return { ok: true, items };
}
