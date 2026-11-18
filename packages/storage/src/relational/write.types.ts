/**
 * Адресная политика записи raw owner; переносимые части импортируются отдельно.
 */
export interface RelationalWriteOptions {
  /* Детерминированная идентичность command effect для выделения новых адресных назначений. */
  readonly allocationId?: string;
  /* assign создаёт ID/ключ; defer оставляет это exact component import до назначения текущей роли. */
  readonly keyMode?: "assign" | "defer";
}

/**
 * Назначение текущего семантического ключа из отдельной таблицы адресов.
 */
export interface CurrentKeyOptions {
  /* Идентичность эффекта, как в RelationalWriteOptions. */
  readonly allocationId?: string;
  /* false требует уже импортированное действующее назначение и не выделяет ID. */
  readonly create?: boolean;
}
