/**
 * Полный согласованный порядок заранее выбранного состава либо отказ без частичного порядка.
 */
export type OrderMergeResult =
  | {
      /* Все ограничения порядка совместимы. */
      readonly ok: true;
      /* Каждый ID из members ровно один раз в согласованном порядке. */
      readonly items: readonly string[];
    }
  | {
      /* Повреждённый ввод, превышение лимита или несовместимые ограничения порядка. */
      readonly ok: false;
    };

/**
 * Узел неявного графа порядка, принадлежащий одному расчёту; входные массивы не изменяются.
 */
export interface OrderNode {
  /* Постоянный ID элемента согласованного состава. */
  readonly id: string;
  /* Позиция в base; undefined означает новый ID. */
  readonly base: number | undefined;
  /* Позиция в local; undefined означает отсутствие на этой стороне. */
  readonly local: number | undefined;
  /* Позиция в remote; undefined означает отсутствие на этой стороне. */
  readonly remote: number | undefined;
  /* Число входящих ограничений от ещё не выданных узлов. */
  incoming: number;
  /* Число инверсий относительно других surviving ID в local. */
  localReversals: number;
  /* Число инверсий относительно других surviving ID в remote. */
  remoteReversals: number;
  /* Число одинаковых инверсий этого ID, выполненных обеими сторонами. */
  sharedReversals: number;
  /* Узел уже добавлен в результирующий порядок. */
  emitted: boolean;
}

/**
 * Отношение пары: -1 — первый раньше, 1 — второй раньше, 0 — общая позиция неизвестна.
 * conflict означает разные позиции нового элемента, заданные обеими сторонами.
 */
export type OrderRelation = -1 | 0 | 1 | "conflict";
