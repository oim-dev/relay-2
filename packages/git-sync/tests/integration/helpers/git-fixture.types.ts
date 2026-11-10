import type { ProjectDatabase } from "@relay/core";
import type { ReplicationAdapter } from "../../../src/sync/replication-adapter";
import type { DataRepository } from "../../../src/transport/repository";
import type { SyncEngine } from "../../../src/sync/engine";
import type { RepositoryOptions } from "../../../src/transport/repository.types";

/**
 * Управляемая граница конечного сценария; watchdog Bun дополнительно оставляет время на drain.
 */
export interface GitFixtureLimits {
  /* Стабильное имя сценария в bounded CI-диагностике; не содержит входных данных проекта. */
  readonly name: string;
  /* Бюджет всей работы в миллисекундах, включая fresh helper и подготовку реплик. */
  readonly deadlineMs: number;
}

/**
 * Изолированная реальная SQLite-реплика с собственным private Git repo.
 */
export interface ReplicaFixture {
  /* Каталог состояния, удаляемый общим fixture после закрытия соединений. */
  readonly directory: string;
  /* Реальная база с durable outbox. */
  readonly db: ProjectDatabase;
  /* Core-стыковка без подмены предметных правил. */
  readonly replication: ReplicationAdapter;
  /* Реальный Git; тест может подменять только границу получения результата push. */
  readonly repository: DataRepository;
  /* Оркестратор одного транспорта. */
  readonly engine: SyncEngine;
}

/**
 * Один общий bare remote и независимые реплики, принадлежащие одному тесту.
 */
export interface GitFixture {
  /* Корень под .artifacts, очищаемый в finally. */
  readonly root: string;
  /* Абсолютный путь стандартного bare Git remote. */
  readonly remote: string;
  /* Отмена Git и тестовых барьеров перед закрытием соединений. */
  readonly signal: AbortSignal;
  /* Отмечает смысловую фазу и запрещает продолжение сценария после управляемой отмены. */
  phase(name: string): void;
  /* Создаёт реплику либо восстанавливает checkpoint, принятый реальным engine указанного источника. */
  replica(
    name: string,
    source?: ReplicaFixture,
    repository?: (options: RepositoryOptions) => DataRepository,
  ): Promise<ReplicaFixture>;
}
