import type { GitSyncEnvironment } from "./client.types";
import type { ProcessCommand } from "./process.types";
import type { ServiceConfiguration } from "./service.types";

/**
 * Изолированное состояние fixture пользовательской службы без native процессов и файлов ОС.
 */
export interface ServiceTestFixture {
  /* Файлы в памяти, включая проверяемый чужой файл данных. */
  readonly files: Map<string, string>;
  /* Запросы к native runner в порядке выполнения. */
  readonly commands: ProcessCommand[];
  /* Явные подмены процесса и файловой системы. */
  readonly environment: GitSyncEnvironment;
  /* Home службы в синтаксисе проверяемой платформы. */
  readonly home: string;
  /* Exact executable, записываемый в native-конфигурацию. */
  readonly binary: string;
  /* Независимо сгенерированная конфигурация для COM-ответов fixture. */
  readonly configuration: ServiceConfiguration;
}
