import type { ProjectDatabase } from "@relay/core";
import type { ProjectLocation } from "@relay/project-runtime";
import type { DataRepository } from "../../../src/transport/repository";
import type { ReplicationAdapter } from "../../../src/sync/replication-adapter";
import type { SyncEngine } from "../../../src/sync/engine";

/**
 * Изолированная project-local реплика; вызывающий закрывает database до cleanup fixture.
 */
export interface LocalProjectReplica {
  /* Корень отдельного Git-репозитория кода. */
  readonly root: string;
  /* Опубликованный Runtime конфиг и SQLite. */
  readonly location: ProjectLocation;
  /* Единственное принадлежащее сценарию соединение. */
  readonly database: ProjectDatabase;
  /* Предметный адаптер той же SQLite. */
  readonly replication: ReplicationAdapter;
  /* Транспорт настоящего linked worktree. */
  readonly repository: DataRepository;
  /* Однопроходный обмен с реальным Core. */
  readonly engine: SyncEngine;
}
