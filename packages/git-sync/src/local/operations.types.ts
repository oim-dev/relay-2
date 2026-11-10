import type { GitSyncControlOutcome } from "@relay/contracts";

/**
 * Исполнитель получает callback фактического старта своего cycle, не I/O контекст предметных команд.
 */
export type NetworkOperation = (started: () => void) => Promise<unknown>;

/**
 * Live обещание не сериализуется; журнал содержит только bounded outcome DTO.
 */
export interface ActiveOperation {
  /* Точная форма принятого запроса для защиты requestId от другого действия. */
  readonly signature: string;
  /* Завершение операции после сохранения terminal outcome. */
  readonly completion: Promise<void>;
}

/**
 * Сохранённый outcome с конечным сроком retention.
 */
export interface StoredOperation {
  /* Наблюдаемое состояние, не выводимое из PID/возраста endpoint. */
  readonly outcome: GitSyncControlOutcome;
  /* Конец retention в epoch milliseconds. */
  readonly expires: number;
}
