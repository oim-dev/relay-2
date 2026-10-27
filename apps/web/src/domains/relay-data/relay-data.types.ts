import type { HttpBatchRequest, BatchResult, NamedCommand } from "@relay/contracts";

/**
 * Запись атомарного пакета с сохранением первоначального ключа при неопределённом исходе.
 */
export type WriteCommands = (
  project: string,
  commands: readonly NamedCommand[],
  operationKey?: string,
) => Promise<BatchResult>;

/**
 * Безопасный снимок неопределённой операции проекта для временного recovery-уведомления.
 * Не содержит изменяемых commands/guards. Объект стабилен до изменения состояния.
 */
export interface PendingWriteRecovery {
  /* Ключ первоначального запроса; явное восстановление обязано адресовать именно его. */
  readonly operationKey: string;
  /* true пока явный повтор проверяет receipt либо отправляет сохранённый запрос. */
  readonly recovering: boolean;
}

/**
 * Восстановление запроса, не зависящее от продолжительности жизни исходной React-формы.
 * Все методы ограничены origin текущей вкладки и переданным постоянным ID проекта.
 */
export interface WriteRecovery {
  /* Стабильный снимок только неопределённой записи; null во время обычного первого submit. */
  readonly getPendingWrite: (project: string) => PendingWriteRecovery | null;
  /* Уведомляет об изменении снимка без I/O; возвращённая функция освобождает подписку. */
  readonly subscribePendingWrite: (project: string, onChange: () => void) => () => void;
  /* Явно восстанавливает исходный запрос; null для отсутствующего/уже заменённого ключа. */
  readonly recoverPendingWrite: (
    project: string,
    operationKey: string,
  ) => Promise<BatchResult | null>;
}

/**
 * Совместимая callable-запись с дополнительным публичным lifecycle восстановления.
 */
export type RecoverableWriteCommands = WriteCommands & WriteRecovery;

/**
 * Замороженная операция вкладки до получения достоверного результата.
 */
export interface PendingWrite {
  /* Первоначальный запрос; отсутствует до context(), guards не обновляются при повторе. */
  request?: HttpBatchRequest;
  /* Копия ввода, сделанная до первого асинхронного чтения контекста. */
  readonly commands: readonly NamedCommand[];
  /* Ключ первого вызова; новый ключ формы не меняет неопределённую операцию. */
  readonly operationKey: string;
  /* Идентичность исходного пользовательского ввода. */
  readonly fingerprint: string;
  /* Общий активный запрос либо отсутствие запроса после сетевого отказа. */
  running?: Promise<BatchResult>;
  /* Проверка квитанции обязательна после неопределённого исхода. */
  uncertain: boolean;
  /* Опубликованный стабильный снимок; отсутствует до первого неопределённого отказа. */
  recovery?: PendingWriteRecovery;
}
