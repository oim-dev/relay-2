import type { RuntimeOptions } from "@relay/project-runtime";

/**
 * Зафиксированная регистрация физической базы; HTTP-клиент не выбирает filesystem пути.
 */
export interface ProjectTarget {
  /* Ожидаемый постоянный ID БД. */
  readonly projectId: string;
  /* dev/inode/birthtime открытой при bootstrap базы. */
  readonly identity: string;
  /* Явная Runtime область конкретной регистрации. */
  readonly options: RuntimeOptions;
}
