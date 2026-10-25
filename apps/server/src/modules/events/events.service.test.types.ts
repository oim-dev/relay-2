import type { EventSubscriber } from "./events.types";

/**
 * Изолированный consumer чистой bounded SSE очереди, без timer и SQLite.
 */
export interface EventStreamFixture {
  /* Реальный Web stream; тест обязан отменить reader в finally. */
  readonly stream: ReadableStream<Uint8Array>;
  /* Вход событий того же consumer, которым пользуется общий watcher. */
  readonly subscriber: EventSubscriber;
  /* Управляемый разрыв соединения, не меняющий глобальное окружение. */
  readonly abort: AbortController;
  /* Число освобождений подписки; должно остаться единицей при повторном закрытии. */
  readonly unsubscribed: () => number;
}
