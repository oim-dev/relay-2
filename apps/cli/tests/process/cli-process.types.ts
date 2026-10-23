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
  /* Текст либо исходные байты stdin с EOF; отсутствие сохраняет openStdin либо закрытый ввод. */
  readonly stdin?: string | Uint8Array;
  /* Минимальная подготовка проекта через Runtime/Core до запуска процесса. */
  readonly prepare?: (directory: string) => void;
  /* Необязательный подкаталог артефактов для согласованного запуска группы проверок. */
  readonly artifactGroup?: string;
}
