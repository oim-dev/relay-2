import type { InvocationResult } from "../helpers/run-fixture.types";

/**
 * Результат бинарника вместе с содержимым изолированного рабочего каталога до очистки.
 */
export interface BinaryResult extends InvocationResult {
  /* Имена созданных файлов; пустой массив подтверждает отсутствие побочных записей. */
  readonly files: readonly string[];
}

/**
 * Параметры принимающей стороны настоящего stdout дочернего процесса.
 */
export interface BinaryOptions {
  /* Закрыть чтение stdout сразу после запуска; по умолчанию поток полностью читается. */
  readonly closeStdout?: boolean;
}
