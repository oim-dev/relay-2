/**
 * Предусловия публичного точечного writer; одно условие обязательно у изменения существующего владельца.
 * Если переданы оба, ни одно не заменяется другим или свежим значением из хранилища.
 */
export interface CommandWriteOptions {
  /* Дословно проверяемый автор операции. */
  readonly actor: string;
  /* Локальный CAS выбранной реплики; прежний WriteOptions остаётся допустимым входом. */
  readonly ifRevision?: number;
  /* Переносимый aggregateVersion владельца; не primary recordVersion. */
  readonly expectedVersion?: string;
}
