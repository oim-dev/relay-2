import type { SyncConfiguration } from "../local/state.types";
import type { ReplicationAdapter } from "../sync/replication-adapter";

/**
 * Одноразовый обмен выбранной физической реплики; соединением продолжает владеть вызывающий.
 */
export interface OneShotInput {
  /* Каталог локального control/state выбранной SQLite. */
  readonly directory: string;
  /* Проверенное подключение; перед сетью повторно сверяется текущая привязка. */
  readonly config: SyncConfiguration;
  /* Снимок до discovery для claim под owner; null означает новое подключение, undefined — discovery не было. */
  readonly expectedConfiguration?: SyncConfiguration | null;
  /* Core-адаптер открытой вызывающим SQLite. */
  readonly replication: ReplicationAdapter;
  /* true выполняет только чтение remote, без push и применения snapshot. */
  readonly refresh: boolean;
  /* Корреляция явной операции; auto не сохраняет outcome. */
  readonly id: string;
  /* Общий бюджет ожидания owner и работы в миллисекундах. */
  readonly timeoutMs: number;
  /* automatic уступает живому владельцу и повторно проверяет durable debounce. */
  readonly mode?: "explicit" | "automatic";
}
