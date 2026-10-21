import {
  validateEntityPageRequest,
  type EntityPage,
  type EntityPageRequest,
  type EntityRecord,
} from "@relay/contracts";

/**
 * Сравнивает строки по кодовым точкам как SQLite BINARY, включая непарные суррогаты из JSON.
 * UTF-8-кодировщик JavaScript для такого сравнения непригоден: он заменяет их на U+FFFD.
 */
function compareSqlText(left: string, right: string): number {
  let a = 0;
  let b = 0;
  while (a < left.length && b < right.length) {
    // Границы цикла гарантируют наличие кодовых точек; ! не скрывает проверку данных.
    const first = left.codePointAt(a)!;
    const second = right.codePointAt(b)!;
    if (first !== second) {
      return first - second;
    }
    a += first > 0xffff ? 2 : 1;
    b += second > 0xffff ? 2 : 1;
  }
  return left.length - right.length;
}

/**
 * Возвращает основное значение сортировки карточки, не меняя её содержание.
 */
function entitySortValue(record: Readonly<EntityRecord>, sort: EntityPageRequest["sort"]): string {
  switch (sort) {
    case "updated":
      return record.updatedAt;
    case "title":
      return String(record.data.title ?? record.data.name ?? "");
    case "key":
      return record.key;
  }
}

/**
 * Формирует окно уже вычисленного предметного состава, не меняя исходную коллекцию.
 * Загруженный набор целиком сортируется до ограничения выдачи; total описывает весь состав.
 * Обычный список должен читать окно непосредственно в Storage, без полной загрузки в Core.
 */
export function pageEntities<T extends EntityRecord>(
  records: readonly T[],
  request: Readonly<EntityPageRequest>,
): EntityPage<T> {
  validateEntityPageRequest(request);
  const direction = request.sort === "updated" ? -1 : 1;
  const items = records
    .map((record) => ({ record, value: entitySortValue(record, request.sort) }))
    .sort(
      (left, right) =>
        compareSqlText(left.value, right.value) * direction ||
        compareSqlText(left.record.id, right.record.id),
    )
    .map(({ record }) => record);
  return {
    total: items.length,
    items: items.slice(request.offset, request.offset + request.limit),
  };
}
