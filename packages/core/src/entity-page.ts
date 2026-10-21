import {
  validateEntityPageRequest,
  type EntityPage,
  type EntityPageRequest,
  type EntityRecord,
} from "@relay/contracts";

function compareSqlText(left: string, right: string): number {
  let a = 0;
  let b = 0;
  while (a < left.length && b < right.length) {
    const first = left.codePointAt(a)!;
    const second = right.codePointAt(b)!;
    if (first !== second) return first - second;
    a += first > 0xffff ? 2 : 1;
    b += second > 0xffff ? 2 : 1;
  }
  return left.length - right.length;
}

/** Окно уже вычисленного предметного состава; обычный список читает окно непосредственно в Storage. */
export function pageEntities<T extends EntityRecord>(
  records: readonly T[],
  request: EntityPageRequest,
): EntityPage<T> {
  validateEntityPageRequest(request);
  const value = (record: T): string =>
    request.sort === "updated"
      ? record.updatedAt
      : request.sort === "title"
        ? String(record.data.title ?? record.data.name ?? "")
        : record.key;
  // Порядок кодовых точек совпадает с SQLite BINARY, включая сохраняемые JSON
  // непарные суррогаты. UTF-8-кодировщик JavaScript подменил бы их символом U+FFFD.
  const items = records
    .map((record) => ({ record, value: value(record) }))
    .sort(
      (left, right) =>
        compareSqlText(left.value, right.value) * (request.sort === "updated" ? -1 : 1) ||
        compareSqlText(left.record.id, right.record.id),
    )
    .map(({ record }) => record);
  return {
    total: items.length,
    items: items.slice(request.offset, request.offset + request.limit),
  };
}
