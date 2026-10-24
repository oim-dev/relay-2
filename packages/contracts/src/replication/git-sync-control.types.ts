import type { GitSyncResponse } from "./git-sync.types";

/**
 * Версионированный локальный запрос конкретному instance. requestId не является ID пользовательской мутации.
 */
export interface GitSyncControlRequest {
  /* Версия локального протокола. */
  readonly version: 1;
  /* Уникальная корреляция принятой операции либо управляющего обращения. */
  readonly requestId: string;
  /* Ожидаемый nonce живого владельца. */
  readonly instance: string;
  /* Служебное действие, включая operation.submit/operation.get/network.lease. */
  readonly action: string;
  /* Проверяемые владельцем аргументы действия. */
  readonly input: Record<string, unknown>;
}

/**
 * Сведения о принятой ограниченно сохраняемой явной сетевой операции.
 */
export interface GitSyncOperationIdentity {
  /* Версия outcome DTO. */
  readonly version: 1;
  /* Устойчивый ID запроса до его истечения; query никогда не запускает его заново. */
  readonly requestId: string;
  /* Владелец, действительно принявший запрос. */
  readonly instance: string;
  /* Только явные сетевые запросы; auto polling не создаёт журнал outcomes. */
  readonly action: "now" | "status";
  /* Время принятия, ISO. */
  readonly acceptedAt: string;
  /* Время начала собственного/coalesced successor cycle, ISO или null в очереди. */
  readonly startedAt: string | null;
}

/**
 * Наблюдаемый исход запроса. Unknown после expiry/потери owner не означает cancellation или success.
 */
export type GitSyncControlOutcome =
  | (GitSyncOperationIdentity & {
      /* Запрос принят и ожидает cycle либо исполняется. */
      readonly state: "queued" | "running";
    })
  | (GitSyncOperationIdentity & {
      /* Операция закончилась успешно. */
      readonly state: "completed";
      /* Время завершения, ISO. */
      readonly completedAt: string;
      /* Первоначальный результат сетевого действия. */
      readonly result: unknown;
    })
  | (GitSyncOperationIdentity & {
      /* Владелец сохранил фактический отказ. */
      readonly state: "failed";
      /* Время отказа, ISO. */
      readonly completedAt: string;
      /* Стабильная bounded диагностика; большие details могут быть опущены. */
      readonly error: Extract<GitSyncResponse, { ok: false }>["error"];
    })
  | {
      /* Версия outcome DTO. */
      readonly version: 1;
      /* Запрошенная корреляция. */
      readonly requestId: string;
      /* Нет достоверного активного/сохранённого результата. */
      readonly state: "unknown";
      /* Последний известный owner либо null при неизвестном ID. */
      readonly instance: string | null;
    };

/**
 * Событие живого HTTP stream lease. EOF удаляет queued/granted место; отдельный release не нужен.
 */
export interface GitSyncNetworkLeaseEvent {
  /* Версия stream протокола. */
  readonly version: 1;
  /* ID соединения lease. */
  readonly leaseId: string;
  /* Корреляция управляющего обращения. */
  readonly requestId: string;
  /* queued ещё не разрешает Git; granted разрешает его только до EOF/abort. */
  readonly state: "queued" | "granted";
}
