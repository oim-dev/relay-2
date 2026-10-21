import type { InvocationResult } from "../helpers/run-fixture.types";

/**
 * Результат бинарника вместе с содержимым изолированного рабочего каталога до очистки.
 */
export interface BinaryResult extends InvocationResult {
  /* Имена созданных файлов; пустой массив подтверждает отсутствие побочных записей. */
  readonly files: readonly string[];
}

/**
 * Параметры процессной проверки CLI с изолированными HOME, cwd и путём к бинарнику.
 */
export interface BinaryOptions {
  /* Закрыть чтение stdout сразу после запуска; по умолчанию поток полностью читается. */
  readonly closeStdout?: boolean;
  /* Оставить stdin открытым без данных, чтобы обнаружить его неожиданное чтение. */
  readonly openStdin?: boolean;
  /* Явный процесс-обёртка, например Bash; по умолчанию запускается сам бинарник. */
  readonly command?: readonly string[];
}
