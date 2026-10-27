import type { WorkflowEnvironment } from "../../../apps/cli/tests/e2e/helpers/workflow-fixture.types";

/**
 * Независимая локальная копия проекта: отдельные HOME, RELAY_HOME и рабочий каталог.
 */
export interface GitSyncReplica extends WorkflowEnvironment {
  /* Изначально пустой каталог для init либо restore через пользовательский CLI. */
  readonly cwd: string;
}

/**
 * Принадлежащий fixture foreground supervisor, запущенный через пользовательскую CLI.
 * Даже отказ ready требует close до удаления каталога реплики.
 */
export interface GitSyncSupervisorProcess {
  /**
   * Ждёт подтверждённый supervisor.status с deadline и проверяет преждевременный выход CLI.
   */
  ready(): Promise<void>;

  /**
   * Останавливает supervisor протоколом, при отказе использует сигнал и parent lease,
   * затем ожидает выход CLI и подтверждённое отсутствие готового supervisor.
   */
  close(): Promise<void>;
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
   * Регистрирует владение фоновым процессом до команды его запуска.
   * close отключит автоматический режим и остановит worker даже при отказе теста.
   */
  ownWorker(replica: GitSyncReplica): void;

  /**
   * Запускает relay git-sync supervise для одного из изолированных HOME и ждёт готовности.
   * Ресурс регистрируется до ожидания: close освобождает его и после отказа запуска.
   */
  startSupervisor(replica: GitSyncReplica): Promise<void>;

  /**
   * Останавливает workers и foreground supervisors до удаления каталогов обеих копий и remote.
   * При ошибке остановки supervisor каталоги сохраняются для диагностики.
   */
  close(): Promise<void>;
}
