/**
 * Один самостоятельный cycle и запросы, принятые до его начала.
 */
export interface PendingExchange {
  /* true означает fetch/validation без apply/push. */
  readonly refreshOnly: boolean;
  /* Общий результат coalesced successor. */
  readonly promise: Promise<void>;
  /* Выполняется при фактическом начале cycle, не при добавлении в очередь. */
  readonly started: (() => void)[];
  /* Завершение всех присоединённых запросов. */
  readonly resolve: () => void;
  /* Отказ всех присоединённых запросов. */
  readonly reject: (error: unknown) => void;
}
