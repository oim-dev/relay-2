import type { CommandObservation, ReplicationReadGuard } from "@relay/contracts";

/**
 * Узкий результат повторной проверки исходной выборки без загрузки содержимого карточек.
 */
export interface CommandSelectionGuard {
  /* SHA-256 исходных идентичностей/ревизий либо специальной технической проекции. */
  readonly fingerprint: string;
  /* Только найденные постоянные ID для явного causal read в commit. */
  readonly ids: readonly string[];
  /* Содержание либо существование цели; комментарий сам по себе не читает содержание. */
  readonly semantic: ReplicationReadGuard["kind"];
}

/**
 * Первоначальное наблюдение и guard одного SQL-снимка до наложения эффектов команды.
 */
export interface CommandSelection {
  /* Ровно один результат входного selector. */
  readonly observation: CommandObservation;
  /* Исходная проверка, не зависящая от последующего изменения observation вызывающим. */
  readonly guard: CommandSelectionGuard;
}

/**
 * Сохранённая история переназначения буквального адреса.
 */
export interface CommandAddressRow {
  /* Текущий владелец буквального ID/ключа/алиаса либо null. */
  readonly currentId: string | null;
  /* Исторический владелец известного переназначения либо null. */
  readonly previousId: string | null;
  /* Текущая цель в технической защите переназначения либо null. */
  readonly remappedId: string | null;
}

/**
 * Точный JSON комментария выбранного журнала, включая carrier непарных UTF-16 code units.
 */
export interface CommandCommentRow {
  /* Постоянный ID задачи-владельца журнала. */
  readonly taskId: string;
  /* Сериализация TaskComment из общей SQL-проекции логического журнала. */
  readonly json: string;
}
