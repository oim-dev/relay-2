import type { HttpProjectEvent } from "@relay/contracts";

/**
 * Poll-уведомление после начального connected, который принадлежит самому stream.
 */
export type ProjectNotification = HttpProjectEvent & {
  /* Изменение, наблюдение живости или ошибка чтения, но не повтор подключения. */
  readonly type: "changed" | "heartbeat" | "storage-error";
};

/**
 * Подписчик одного проекта; закрытие освобождает собственный Web stream.
 */
export interface EventSubscriber {
  /* Последнее уведомление типа заменяет непрочитанное; общий watcher не блокируется consumer. */
  readonly send: (event: ProjectNotification) => void;
  /* Идемпотентное завершение потока. */
  readonly stop: () => void;
}

/**
 * Присоединяет stream к watcher и передаёт ему идемпотентную функцию отписки.
 */
export type SubscribeProjectEvents = (subscriber: EventSubscriber) => () => void;

/**
 * Единственный watcher поколения для всех подписчиков одного проекта.
 */
export interface ProjectWatch {
  /* Последнее прочитанное поколение. */
  generation: number;
  /* Время последнего события для heartbeat, Unix milliseconds. */
  timestamp: number;
  /* Активные Web streams проекта. */
  readonly subscribers: Set<EventSubscriber>;
  /* Таймер ограниченной проверки generation. */
  readonly timer: ReturnType<typeof setInterval>;
  /* Запрещает перекрывающиеся poll одного проекта. */
  busy: boolean;
}
