import type { Database } from "bun:sqlite";
import {
  RelayError,
  type BatchResult,
  type CommandCommitPlan,
  type CommandCommitResult,
  type CommandLoadRequest,
  type CommandLoadResult,
  type CommandReadAnchor,
  type CommandStore,
} from "@relay/contracts";
import { insertBatchReceipt, readBatchReceipt } from "../batch/batch-receipts";
import { observeReplicationReads } from "../replication/replication-reads";
import { storageError } from "../sqlite/sqlite-errors";
import { isPromiseLike } from "../sqlite/transaction-callback";
import { applyCommandCounters } from "./command-keys";
import { applyCommandTransitions } from "./command-effects";
import { readCommandFacts, readCommandGeneration, validateFreshTaskIds } from "./command-facts";
import { loadCommandSelection, readCommandGuard } from "./command-selections";
import type { SqliteCommandStoreHost } from "./sqlite-command-store.types";
import { commandStorageMessages } from "./command.messages";

/**
 * Внутренний sentinel проходит через перевод ошибок host с сохранением идентичности.
 * Только соответствующий commit превращает уже выполненный rollback в успешный checked.
 */
class CheckedCommand extends RelayError {
  /* Первоначальный результат полностью исполненной, но откатившейся проверки. */
  readonly result: BatchResult;

  /**
   * Сохраняет результат до принудительного отката внешней транзакции.
   */
  constructor(result: BatchResult) {
    super("COMMAND_CHECK_ROLLBACK", commandStorageMessages.checkRollback);
    this.result = result;
  }
}

/**
 * Отвергает async callback до его запуска: его продолжение не должно покинуть область SQLite.
 */
function requireSynchronousCallback(callback: unknown): void {
  if (Object.prototype.toString.call(callback) === "[object AsyncFunction]") {
    throw new RelayError("ASYNC_TRANSACTION", commandStorageMessages.asyncCallback);
  }
}

/**
 * Отвергает Promise/thenable после обычного callback, сохраняя rollback его синхронных эффектов.
 */
function requireSynchronousResult(result: unknown): void {
  if (isPromiseLike(result)) {
    void Promise.resolve(result).catch(() => {});
    throw new RelayError("ASYNC_TRANSACTION", commandStorageMessages.asyncCallback);
  }
}

/**
 * Async I/O-порт над синхронным SQLite: ни один await не удерживает snapshot или writer lock.
 * Чистые планы применяются один раз; повторная подготовка и implicit retry отсутствуют.
 */
export class SqliteCommandStore implements CommandStore {
  /* Постоянный ID выбранного проекта. */
  readonly projectId: string;
  /* Заимствованное соединение; временем его жизни владеет host. */
  private readonly connection: Database;
  /* Строго синхронные границы того же соединения, включая outer outbox flush. */
  private readonly host: SqliteCommandStoreHost;

  /**
   * Принимает готовое соединение со схемой v4 без чтения SQL и владения его закрытием.
   */
  constructor(connection: Database, host: SqliteCommandStoreHost) {
    requireSynchronousCallback(host.snapshot);
    requireSynchronousCallback(host.transaction);
    this.connection = connection;
    this.host = host;
    this.projectId = host.projectId;
  }

  /**
   * Загружает все selectors в одном синхронном snapshot и проверяет переданный anchor до чтений.
   * Предметное generation читается в том же снимке отдельно от технической revision anchor.
   * Новое состояние не подменяет anchor предыдущих загрузок; side-effect reads фасада не используются.
   */
  async load(request: CommandLoadRequest): Promise<CommandLoadResult> {
    try {
      const result = this.host.snapshot(() => {
        const anchor = this.readAnchor();
        if (
          request.anchor !== null &&
          (request.anchor.replicaId !== anchor.replicaId ||
            request.anchor.revision !== anchor.revision)
        ) {
          throw new RelayError(
            "COMMAND_CONTEXT_CHANGED",
            commandStorageMessages.contextChanged,
            4,
            { expected: request.anchor, actual: anchor },
          );
        }
        const selectors = structuredClone(request.selectors);
        const selections = selectors.map((selector) =>
          loadCommandSelection(this.connection, selector),
        );
        return {
          anchor,
          generation: readCommandGeneration(this.connection),
          observations: selections.map((selection) => selection.observation),
          guards: selectors.map((selector, index) => {
            const selection = selections[index];
            if (selection === undefined) {
              throw new Error("COMMAND_SELECTION_MISSING");
            }
            return { selector, fingerprint: selection.guard.fingerprint };
          }),
        };
      });
      requireSynchronousResult(result);
      return result;
    } catch (error) {
      throw this.commandError(error);
    }
  }

  /**
   * Применяет готовый план в одной внешней transaction: идентичность реплики, receipt, guards, counters, tape,
   * синхронный finalize и receipt. Host сохраняет outbox атомарно до разрешения Promise.
   * check исполняет тот же SQL, затем sentinel откатывает всё, включая ключи и capture tape.
   */
  async commit(plan: CommandCommitPlan): Promise<CommandCommitResult> {
    try {
      if (plan.projectId !== this.projectId) {
        throw new RelayError("PROJECT_MISMATCH", commandStorageMessages.projectMismatch, 4);
      }
      if (this.connection.inTransaction) {
        throw new RelayError("TRANSACTION_ACTIVE", commandStorageMessages.activeTransaction);
      }
      const outcome = this.host.transaction(() => this.commitSynchronous(plan));
      requireSynchronousResult(outcome);
      return outcome;
    } catch (error) {
      if (error instanceof CheckedCommand) {
        return { kind: "checked", result: error.result };
      }
      throw this.commandError(error);
    }
  }

  /**
   * Проверяет физическую реплику под замком записи, затем ищет receipt до новых guards/finalize.
   * Локальная read revision здесь не сравнивается: конкурентность защищают выбранные предикаты.
   */
  private commitSynchronous(plan: CommandCommitPlan): CommandCommitResult {
    const actualReplicaId = this.readAnchor().replicaId;
    if (plan.replicaId !== actualReplicaId) {
      throw new RelayError("REPLICA_MISMATCH", commandStorageMessages.replicaMismatch, 4, {
        expectedReplicaId: plan.replicaId,
        actualReplicaId,
      });
    }
    if (plan.receipt !== null) {
      const receipt = readBatchReceipt(this.connection, plan.receipt.operationKey);
      if (receipt !== undefined) {
        if (receipt.requestJson !== plan.receipt.requestJson) {
          throw new RelayError("CONFLICT", commandStorageMessages.receiptConflict, 4, {
            operationKey: receipt.operationKey,
          });
        }
        return { kind: "replayed", receipt };
      }
    }
    requireSynchronousCallback(plan.finalize);
    validateFreshTaskIds(plan);
    const dependencies = plan.guards.map((guard) => {
      const actual = readCommandGuard(this.connection, guard.selector);
      if (actual.fingerprint !== guard.fingerprint) {
        throw new RelayError("COMMAND_CONTEXT_CHANGED", commandStorageMessages.contextChanged, 4, {
          selector: guard.selector,
        });
      }
      return actual;
    });
    for (const semantic of ["existence", "content"] as const) {
      const ids = [
        ...new Set(
          dependencies.filter((entry) => entry.semantic === semantic).flatMap((entry) => entry.ids),
        ),
      ];
      if (ids.length > 0) {
        observeReplicationReads(this.connection, ids, semantic);
      }
    }
    applyCommandCounters(this.connection, plan.counters);
    applyCommandTransitions(this.connection, plan);
    const result = plan.finalize(
      readCommandFacts(this.connection, plan.commentTaskIds, plan.freshTaskIds),
    );
    requireSynchronousResult(result);
    if (plan.receipt !== null) {
      insertBatchReceipt(this.connection, { ...plan.receipt, resultJson: JSON.stringify(result) });
    }
    if (plan.check) {
      throw new CheckedCommand(result);
    }
    return { kind: "committed", result };
  }

  /**
   * Читает скалярное состояние всех наблюдаемых источников без полного снимка репликации.
   */
  private readAnchor(): CommandReadAnchor {
    const anchor = this.connection
      .query<CommandReadAnchor, []>(
        "SELECT replica_id AS replicaId,revision FROM command_read_state WHERE singleton=1",
      )
      .get();
    if (anchor === null) {
      throw new RelayError("DATABASE_INVALID", commandStorageMessages.anchorMissing);
    }
    return anchor;
  }

  /**
   * Сохраняет все предметные RelayError и отличает технический отказ от stale guards.
   */
  private commandError(error: unknown): Error {
    const translated = storageError(error, this.connection.filename);
    if (translated instanceof RelayError) {
      return translated;
    }
    const failure = new RelayError("STORAGE_ERROR", commandStorageMessages.storageFailure);
    failure.cause = translated;
    return failure;
  }
}
