/**
 * Неизменяемая техническая квитанция; предметный JSON декодирует Core.
 */
export interface StoredBatchReceipt {
  /* Уникальный в проектной БД ключ доставки без срока истечения. */
  readonly operationKey: string;
  /* Канонический JSON запроса вместе с автором до разрешения адресов и CAS. */
  readonly requestJson: string;
  /* Первоначальный полный результат, сериализованный Core в JSON. */
  readonly resultJson: string;
}
