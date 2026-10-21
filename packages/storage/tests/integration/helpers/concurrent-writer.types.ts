import type { Worker } from "node:worker_threads";

/**
 * Изолированные параметры писателя, передаваемые родителем в workerData.
 */
export interface ConcurrentWriterInput {
  /* Абсолютный путь общей для двух писателей тестовой базы. */
  readonly path: string;
  /* Метка автора, позволяющая различить конкурентные обновления. */
  readonly actor: string;
}

/**
 * Подтверждённые записи одного участника конкурентного сценария.
 */
export interface ConcurrentWriterResult {
  /* Шесть зарезервированных и сохранённых ключей, в порядке записи этого участника. */
  readonly keys: readonly string[];
  /* Исход единственной попытки CAS общей начальной ревизии паспорта. */
  readonly outcome: "updated" | "REVISION_CONFLICT";
}

/**
 * Протокол барьера: готовность означает, что начальная ревизия уже прочитана.
 */
export type ConcurrentWriterMessage =
  | {
      /* Сигнал ожидания команды записи от родителя. */
      readonly type: "ready";
    }
  | (ConcurrentWriterResult & {
      /* Сигнал завершения всех записей участника. */
      readonly type: "result";
    });

/**
 * Ресурсы одного worker; создавший тест обязан завершить его в finally.
 */
export interface ConcurrentWriterHandle {
  /* Живой поток Bun с отдельным соединением SQLite. */
  readonly worker: Worker;
  /* Выполняется после чтения общей ревизии или отклоняется при ошибке участника. */
  readonly ready: Promise<void>;
  /* Результат всех подтверждённых записей либо ошибка исполнения/протокола. */
  readonly result: Promise<ConcurrentWriterResult>;
}
