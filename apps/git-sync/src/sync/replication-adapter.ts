import { realpathSync } from "node:fs";
import {
  ReplicationService,
  ProjectDatabase,
  decodeReplicationSnapshot,
  validateReplicationHistory,
  type ValidatedReplicationHistory,
  type ReplicationPrepareOptions,
  type ReplicationDependencyWait,
} from "@relay/core";
import type {
  PortableProjectSnapshot,
  ReplicationConflict,
  ReplicationDecision,
  ReplicationStatus,
  ReplicationHistoryInput,
  ReplicationBootstrapOptions,
} from "@relay/contracts";
import type { ReplicationDiagnostics } from "./replication-adapter.types";

/**
 * Единственная стыковка транспорта с Core. Не содержит merge-правил или прямого SQL.
 * Соединением владеет вызывающий worker; все сетевые ожидания выполняются вне Core-транзакций.
 */
export class ReplicationAdapter {
  /* Предметный владелец capture, merge, validation и идемпотентного apply. */
  readonly core: ReplicationService;
  /* Открытая техническая база для read-only accepted cursor; SQL и её lifecycle остаются у Storage/Runtime. */
  private readonly database: ProjectDatabase;
  /* Физическая БД этой очереди; symlink не создаёт другую область durable cursor. */
  readonly databaseIdentity: string;

  /**
   * Создаёт предметный сервис поверх уже проверенной базы Runtime.
   */
  constructor(database: ProjectDatabase) {
    this.core = new ReplicationService(database);
    this.database = database;
    this.databaseIdentity = realpathSync(database.path);
  }

  /**
   * Читает переносимое состояние одним Core capture, сохраняя его предметную канонизацию.
   */
  capture(): PortableProjectSnapshot {
    return this.core.capture();
  }

  /**
   * Читает durable очередь и версии метаданных без Git и без собственного SQL.
   */
  status(): ReplicationStatus {
    return this.core.status();
  }

  /**
   * Возвращает сохранённые трёхсторонние материалы целых конфликтующих changeset.
   */
  conflicts(): readonly ReplicationConflict[] {
    return this.core.conflicts();
  }

  /**
   * Читает полный граф ожиданий только по явному запросу диагностики, вне status/prepare.
   */
  blocked(): readonly ReplicationDependencyWait[] {
    return this.core.blocked();
  }

  /**
   * Читает conflicts и полный blocked-граф в одном SQL snapshot по явному диагностическому запросу.
   */
  diagnostics(): ReplicationDiagnostics {
    return this.database.snapshot(() => ({ conflicts: this.conflicts(), blocked: this.blocked() }));
  }

  /**
   * Проверяет и готовит объединение только через Core; результат ещё не считается опубликованным.
   */
  prepare(
    remote: PortableProjectSnapshot | null,
    history: ReplicationHistoryInput | ValidatedReplicationHistory = {},
    options: ReplicationPrepareOptions = {},
  ): ReturnType<ReplicationService["prepare"]> {
    return this.core.prepare(remote, history, options);
  }

  /**
   * Принимает реально подтверждённый Git снимок, сохраняя новые конкурентные локальные изменения.
   */
  accept(
    snapshot: PortableProjectSnapshot,
    history: ReplicationHistoryInput | ValidatedReplicationHistory = {},
  ): ReturnType<ReplicationService["accept"]> {
    return this.core.accept(snapshot, history);
  }

  /**
   * Получает реальный Core base, не подменяя его fetched ref или capture с publication:null.
   */
  acceptedSnapshot(): PortableProjectSnapshot | null {
    const base = this.database.snapshot(() => this.database.getReplicationState().base);
    return base === null ? null : decodeReplicationSnapshot(base);
  }

  /**
   * Проверяет canonical history чистым Core API без изменения observed/conflicts/local rows.
   */
  validateHistory(
    base: PortableProjectSnapshot | null,
    remote: PortableProjectSnapshot,
    history: ReplicationHistoryInput = {},
  ): ValidatedReplicationHistory {
    return validateReplicationHistory(base, remote, history);
  }

  /**
   * Передаёт явное решение конфликта его предметному владельцу с защитой fingerprint.
   */
  resolve(
    id: string,
    decision: ReplicationDecision,
    actor: string,
  ): ReturnType<ReplicationService["resolve"]> {
    return this.core.resolve(id, decision, actor);
  }
}

/**
 * Создаёт новую staging-реплику Core, сохраняя ID/квитанции и получая новый локальный replicaId.
 * Соединение закрывается до атомарной публикации Runtime; существующий файл не заменяется.
 */
export function restoreSnapshot(
  databasePath: string,
  snapshot: PortableProjectSnapshot,
  options: ReplicationBootstrapOptions = {},
): void {
  const database = ProjectDatabase.createReplica(databasePath, snapshot.projectId);
  try {
    new ReplicationService(database).bootstrap(snapshot, options);
  } finally {
    database.close();
  }
}

/**
 * Передаёт raw JSON единственному Core decoder; source/tape/resolution остаются дословными DTO владельца.
 */
export function decodeSnapshotValue(value: unknown): PortableProjectSnapshot {
  return decodeReplicationSnapshot(value);
}

/**
 * Проверяет историю до создания staging-БД restore, не создавая временный предметный store.
 */
export function validateSnapshotHistory(
  base: PortableProjectSnapshot | null,
  remote: PortableProjectSnapshot,
  history: ReplicationHistoryInput = {},
): ValidatedReplicationHistory {
  return validateReplicationHistory(base, remote, history);
}

/**
 * Проверяет согласованное фактическое локальное состояние resume без bootstrap, ack или изменения строк.
 * Readonly-соединение не включает WAL и не мигрирует схему; закрывается до Runtime publication.
 */
export function validatePreservedDatabase(databasePath: string): void {
  const database = ProjectDatabase.openReadonly(databasePath);
  try {
    database.snapshot(() => {
      decodeReplicationSnapshot(new ReplicationService(database).capture());
    });
  } finally {
    database.close();
  }
}
