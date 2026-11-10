import type { WorkflowEnvironment } from "../../../apps/cli/tests/e2e/helpers/workflow-fixture.types";

/**
 * Независимая локальная копия проекта: отдельные HOME, RELAY_HOME и рабочий каталог.
 */
export interface GitSyncReplica extends WorkflowEnvironment {
  /* Изначально пустой каталог для init либо restore через пользовательский CLI. */
  readonly cwd: string;
}

/**
 * Два участника и настоящий локальный bare remote одного сквозного маршрута.
 * Предметные записи и подключение создаёт сам тест; close обязателен в finally.
 */
export interface GitSyncFixture {
  /* Общий каталог только этого маршрута под .artifacts. */
  readonly root: string;
  /* Абсолютный путь изначально пустого bare-репозитория. */
  readonly remote: string;
  /* Первая независимая локальная копия. */
  readonly a: GitSyncReplica;
  /* Вторая независимая локальная копия с другим HOME. */
  readonly b: GitSyncReplica;

  /**
   * Ожидает принадлежащие fixture процессы до удаления каталогов обеих копий и remote.
   */
  close(): Promise<void>;
}
