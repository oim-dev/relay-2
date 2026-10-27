/**
 * Последнее транспортное состояние; sequence монотонен в пределах страницы.
 */
export interface WorkspaceSignal {
  /* Состояние соединения либо отказа серверного хранилища. */
  readonly state: "connecting" | "connected" | "reconnecting" | "disconnected" | "storage-error";
  /* Номер уведомления, включая повторное подключение. */
  readonly sequence: number;
  /* Диагностика отказа; отсутствует при штатном состоянии. */
  readonly message?: string;
  /* Машинный код серверного отказа, если он известен. */
  readonly code?: string;
}

/**
 * События, изменяющие состояние или подтверждённый GET-кеш; heartbeat не инвалидирует его.
 */
export type WorkspaceEventName = "connected" | "changed" | "storage-error";

/**
 * Предметная часть события без счётчика локального соединения.
 */
export type WorkspaceNotification = Omit<WorkspaceSignal, "sequence">;

/**
 * Подписка на разделяемый поток; возвращённая функция освобождает только своего слушателя.
 */
export type WorkspaceSubscribe = (listener: (signal: WorkspaceSignal) => void) => () => void;
