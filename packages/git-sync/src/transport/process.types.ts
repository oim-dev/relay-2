/**
 * Ограниченный запуск внешнего процесса без изменения окружения вызывающего.
 */
export interface ProcessInput {
  /* Исполняемый файл; оболочка не используется. */
  readonly executable: string;
  /* Аргументы передаются дословно отдельными элементами. */
  readonly args: readonly string[];
  /* Явный рабочий каталог дочернего процесса. */
  readonly cwd: string;
  /* Дополнения к унаследованному окружению только этого процесса. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /* Полное содержимое stdin; отсутствие означает закрытый пустой ввод. */
  readonly input?: string | Uint8Array;
  /* Общий deadline в миллисекундах, по умолчанию 30 секунд. */
  readonly timeoutMs?: number;
  /* Общий бюджет stdout/stderr в байтах, по умолчанию 16 MiB, максимум 128 MiB. */
  readonly maxBytes?: number;
  /* Отмена завершает принадлежащую запуску группу процессов. */
  readonly signal?: AbortSignal;
}

/**
 * Завершённый процесс; ненулевой exitCode интерпретирует владелец команды.
 */
export interface ProcessResult {
  /* Код завершения либо 128 при завершении сигналом. */
  readonly exitCode: number;
  /* Собранный ограниченный поток stdout без преобразования байтов. */
  readonly stdout: Buffer;
  /* Собранный ограниченный поток stderr без преобразования байтов. */
  readonly stderr: Buffer;
}
