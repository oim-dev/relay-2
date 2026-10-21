import type { EntityKind, EntityRecord, RelayError, TaskRecord } from "@relay/contracts";

/**
 * Индексы сырых записей одного диагностического снимка.
 * До предметного декодирования значения ID участий остаются непроверенными,
 * чтобы диагностика ссылок не скрывала повреждённую форму данных.
 */
export interface EntityIntegrityIndex {
  /* Записи по постоянному ID; повторный ID выявляется сравнением размера с исходным набором. */
  readonly byId: ReadonlyMap<string, EntityRecord>;
  /* Число записей каждого встретившегося вида; отсутствие вида означает 0. */
  readonly counts: ReadonlyMap<EntityKind, number>;
  /* Число досок с продуктовым slug, для проверки единственности seed-доски. */
  readonly productBoards: number;
  /* Сырые ID участий по ID записи с массивом runs; отсутствие означает неверную форму runs. */
  readonly runIds: ReadonlyMap<string, ReadonlySet<unknown>>;
}

/**
 * Результат предметного декодирования для последующей проверки графа задач.
 */
export interface EntityDecodingInspection {
  /* Полностью проверенные карточки задач в порядке исходного набора. */
  readonly tasks: readonly TaskRecord[];
  /* Первая повреждённая задача; запрещает считать неполный набор корректным графом. */
  readonly taskError: RelayError | undefined;
  /* Диагностики повреждённых карточек с их ключами. */
  readonly issues: readonly string[];
}
