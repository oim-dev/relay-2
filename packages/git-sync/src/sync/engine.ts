import { join } from "node:path";
import {
  RelayError,
  type PortableProjectSnapshot,
  type ReplicationHistoryInput,
} from "@relay/contracts";
import { decodeSnapshot, encodeSnapshot } from "../snapshot/codec";
import { requireGit } from "../transport/git";
import { transportMessages } from "../transport/transport.messages";
import { failure } from "../app/errors";
import { writeLocalJson } from "../local/files";
import { initialProgress, readProgress } from "../local/state";
import type { SyncProgress } from "../local/state.types";
import type { CachedRemoteSnapshot, ReplicationPort, RepositoryPort } from "./engine.types";
import { readPublicationHistory } from "./publication-reader";
import type {
  BoundedPreparedReplication,
  ReplicationPublicationBudget,
  ValidatedReplicationHistory,
} from "@relay/core";
import { waitUntil } from "../local/deadline";
export { waitUntil } from "../local/deadline";

/**
 * Сериализует сетевые циклы одной физической реплики; не удерживает SQL через await.
 * Retry пересобирает кандидат на новом remote, никогда не повторяет пользовательскую мутацию.
 */
export class SyncEngine {
  /* Сохранённая наблюдаемость транспорта без предметных временных победителей. */
  readonly progress: SyncProgress;
  /* Единственный выполняющийся сетевой цикл. */
  private active: Promise<void> | null = null;
  /* Bounded cache одного immutable remote head; старый снимок заменяется при продвижении ветки. */
  private remoteCache: CachedRemoteSnapshot | null = null;
  /* Head, фактически принятый Core этим процессом; после restart сначала нужна полная проверка. */
  private acceptedHead: string | null = null;
  /* Поколение после последнего Core accept, защищающее idle fast path от новых local writes. */
  private acceptedGeneration: number | null = null;
  /* SQL base читается единожды и обновляется только после успешного Core accept этого owner. */
  private acceptedSnapshotCache: PortableProjectSnapshot | null | undefined;
  /* Каталог приватной диагностики. */
  private readonly directory: string;
  /* Ожидаемый постоянный ID проекта. */
  private readonly projectId: string;
  /* Core-владелец изменений. */
  private readonly replication: ReplicationPort;
  /* Транспорт общей ветки. */
  private readonly repository: RepositoryPort;
  /* Общая отмена worker. */
  private readonly signal: AbortSignal;
  /* Scope конкретного host lease; owner signal продолжает действовать между попытками. */
  private attemptSignal: AbortSignal | null = null;
  /* Необязательное уменьшение конечного Core budget для изолированных сценариев. */
  private readonly publicationBudget: Partial<ReplicationPublicationBudget> | undefined;

  /**
   * Читает durable cursor до prepare, связывая его с физической БД и replicaId без сети.
   * publicationBudget допускает только уменьшение конечного бюджета Core.
   */
  constructor(
    directory: string,
    projectId: string,
    replication: ReplicationPort,
    repository: RepositoryPort,
    signal: AbortSignal,
    publicationBudget?: Partial<ReplicationPublicationBudget>,
  ) {
    this.directory = directory;
    this.projectId = projectId;
    this.replication = replication;
    this.repository = repository;
    this.signal = signal;
    this.publicationBudget = publicationBudget;
    this.progress = readProgress(directory);
    const { replicaId } = replication.status();
    if (this.progress.publicationReplicaId === null) {
      this.progress.afterSequence = 0;
      this.progress.publicationWindow = null;
    }
    if (
      this.progress.publicationReplicaId !== null &&
      (this.progress.publicationReplicaId !== replicaId ||
        this.progress.publicationDatabaseIdentity !== replication.databaseIdentity)
    ) {
      Object.assign(this.progress, initialProgress());
    }
    this.progress.publicationReplicaId = replicaId;
    this.progress.publicationDatabaseIdentity = replication.databaseIdentity;
    this.progress.phase = "idle";
    this.progress.nextRetry = null;
  }

  /**
   * Сохраняет фазу и фактический retry; stdout остаётся исключительно процессным протоколом.
   */
  save(): void {
    writeLocalJson(join(this.directory, "progress.json"), this.progress);
  }

  /**
   * Сообщает занятость без ожидания длительного Git fetch.
   */
  get busy(): boolean {
    return this.active !== null;
  }

  /**
   * Ждёт завершения текущего цикла после внешней отмены; новый цикл не запускает.
   */
  async settled(): Promise<void> {
    await this.active?.catch(() => {});
  }

  /**
   * Выполняет только один cycle. Очередь/coalescing принадлежат NetworkExchange, а не второму скрытому policy.
   */
  async run(refreshOnly = false, signal: AbortSignal = this.signal): Promise<void> {
    if (this.active) {
      throw new RelayError("GIT_SYNC_BUSY", transportMessages.busy, 4);
    }
    this.attemptSignal = AbortSignal.any([this.signal, signal]);
    this.repository.setAttemptSignal(this.attemptSignal);
    const operation = this.cycle(refreshOnly);
    this.active = operation;
    try {
      await operation;
    } finally {
      this.active = null;
      this.attemptSignal = null;
      this.repository.setAttemptSignal(null);
    }
  }

  /**
   * Проверяет фактическую Git history и Core publication replay. Refresh не применяет ни одной пачки.
   */
  private async remote(applyIncoming = true): Promise<{
    head: string | null;
    snapshot: PortableProjectSnapshot | null;
  }> {
    this.progress.phase = "fetching";
    this.save();
    const head = await this.repository.fetch();
    this.progress.phase = "validating";
    this.save();
    let snapshot: PortableProjectSnapshot | null = null;
    if (head) {
      if (this.remoteCache?.head === head && (!applyIncoming || this.acceptedHead === head)) {
        snapshot = this.remoteCache.snapshot;
      } else {
        this.acceptedSnapshotCache ??= this.replication.acceptedSnapshot();
        const cache = new Map<string, PortableProjectSnapshot>();
        if (this.remoteCache) {
          cache.set(this.remoteCache.head, this.remoteCache.snapshot);
        }
        if (this.acceptedHead && this.acceptedSnapshotCache) {
          cache.set(this.acceptedHead, this.acceptedSnapshotCache);
        }
        snapshot = await readPublicationHistory(
          this.repository,
          head,
          {
            decode: decodeSnapshot,
            validate: (base, remote, history) =>
              this.replication.validateHistory(base, remote, history),
          },
          {
            projectId: this.projectId,
            base: this.acceptedSnapshotCache,
            cache,
            ...(applyIncoming
              ? {
                  consume: async (batch) => {
                    await this.accept(batch.head, batch.proof.snapshot, batch.proof);
                    this.progress.phase = "validating";
                    this.save();
                  },
                }
              : {}),
          },
        );
        if (applyIncoming && this.acceptedHead !== head) {
          await this.accept(head, snapshot);
        }
        this.remoteCache = { head, snapshot };
      }
    }
    this.progress.lastFetch = new Date().toISOString();
    return { head, snapshot };
  }

  /**
   * Принимает только опубликованную сторону и обновляет диагностику после успешного Core apply.
   */
  private async accept(
    head: string,
    snapshot: PortableProjectSnapshot,
    history: ReplicationHistoryInput | ValidatedReplicationHistory = {},
  ): Promise<void> {
    this.progress.phase = "accepting";
    this.save();
    const accepted = this.replication.accept(snapshot, history);
    this.acceptedHead = head;
    this.acceptedGeneration = accepted.generation;
    this.acceptedSnapshotCache = snapshot;
    this.remoteCache = { head, snapshot };
    this.progress.conflictsHead = head;
    this.progress.conflictsGeneration = accepted.generation;
    this.progress.conflictsObservedAt = new Date().toISOString();
    this.progress.conflictsComplete = true;
    await this.repository.accepted(head);
    this.progress.git = await this.repository.counts();
    this.progress.lastSuccess = new Date().toISOString();
    this.progress.exportedCount = 0;
    this.progress.exportedGeneration = null;
  }

  /**
   * Завершает одно bounded окно, повторяя его исходный cursor при non-FF (не более шести попыток).
   * Неизвестный push не продвигает cursor до доказанного accept; поздние записи остаются pending.
   */
  private async publish(): Promise<void> {
    const afterSequence = this.progress.afterSequence;
    for (let attempt = 0; attempt < 6; attempt++) {
      const remote = await this.remote();
      const local = this.replication.status();
      if (
        remote.head === this.acceptedHead &&
        this.acceptedHead !== null &&
        local.generation === this.acceptedGeneration &&
        local.pending === 0 &&
        local.conflicts === 0
      ) {
        this.progress.afterSequence = 0;
        this.progress.publicationWindow = null;
        this.progress.lastSuccess = new Date().toISOString();
        return;
      }
      this.progress.phase = "preparing";
      this.save();
      const prepared = this.replication.prepare(
        remote.snapshot,
        {},
        {
          afterSequence,
          ...(this.publicationBudget ? { budget: this.publicationBudget } : {}),
        },
      );
      const { waiting: _waiting, pending: _pending, ...selection } = prepared.selection;
      this.progress.publicationWindow = {
        ...selection,
        included: prepared.included,
        completed: false,
      };
      this.progress.conflictsHead = remote.head;
      this.progress.conflictsGeneration = prepared.generation;
      this.progress.conflictsObservedAt = new Date().toISOString();
      this.progress.conflictsComplete =
        prepared.selection.examined.length === prepared.selection.pending;
      const checkpoint = {
        version: 1,
        generation: prepared.generation,
        operationIds: prepared.included,
        parent: remote.head,
        replicaId: this.progress.publicationReplicaId,
        databaseIdentity: this.progress.publicationDatabaseIdentity,
        selection: prepared.selection,
      };
      writeLocalJson(join(this.directory, "prepared.json"), checkpoint);
      if (remote.head) {
        await this.repository.rememberRemote(remote.head);
      }
      if (prepared.included.length === 0) {
        if (remote.head && remote.snapshot && this.acceptedHead !== remote.head) {
          await this.accept(remote.head, remote.snapshot);
        }
        this.completeWindow(prepared);
        return;
      }
      if (!prepared.snapshot.publication) {
        throw new RelayError("GIT_PUBLICATION_REQUIRED", transportMessages.publicationRequired, 4);
      }
      // Core prepare уже проверил и зарегистрировал sealed direct candidate после локального guard.
      // Пустой history input переиспользует это authority, а не требует повторного replay своей tape.
      const proof = this.replication.validateHistory(remote.snapshot, prepared.snapshot);
      this.progress.phase = "committing";
      this.save();
      const commit = await this.repository.commit(encodeSnapshot(proof.snapshot), remote.head);
      writeLocalJson(join(this.directory, "prepared.json"), { ...checkpoint, commit });
      this.progress.git = await this.repository.counts();
      this.progress.exportedGeneration = prepared.generation;
      this.progress.exportedCount = prepared.included.length;
      if (commit === remote.head) {
        await this.accept(commit, proof.snapshot, proof);
        this.completeWindow(prepared);
        return;
      }
      this.progress.phase = "pushing";
      this.save();
      let pushError: unknown;
      try {
        requireGit(await this.repository.push(commit), "push");
      } catch (error) {
        pushError = error;
      }
      if (pushError === undefined) {
        await this.accept(commit, proof.snapshot, proof);
        this.completeWindow(prepared);
        return;
      }
      // Потеря ответа не означает отказ remote: читаем фактически принятую историю.
      this.progress.phase = "outcome-unknown";
      this.save();
      let observed: Awaited<ReturnType<SyncEngine["remote"]>>;
      try {
        observed = await this.remote();
      } catch (verificationError) {
        this.progress.phase = "outcome-unknown";
        throw new RelayError("GIT_PUSH_OUTCOME_UNKNOWN", transportMessages.outcomeUnknown, 4, {
          commit,
          push: failure(pushError).error,
          verification: failure(verificationError).error,
        });
      }
      if (
        observed.head &&
        observed.snapshot &&
        (await this.repository.isAncestor(commit, observed.head))
      ) {
        if (this.acceptedHead !== observed.head) {
          await this.accept(observed.head, observed.snapshot);
        }
        this.completeWindow(prepared);
        return;
      }
      if (observed.head === remote.head) {
        throw pushError;
      }
      const delay = Math.min(2000, 80 * 2 ** attempt) * (0.5 + Math.random());
      this.progress.phase = "retrying";
      this.progress.nextRetry = new Date(Date.now() + delay).toISOString();
      this.save();
      await waitUntil(Date.parse(this.progress.nextRetry), this.attemptSignal ?? this.signal);
      this.progress.nextRetry = null;
    }
    throw new RelayError("GIT_RETRY_EXHAUSTED", transportMessages.retries, 4);
  }

  /**
   * Продвигает durable cursor только после установленного исхода окна.
   * Пустое окно завершает просмотр без ACK; конец обхода возвращает cursor к нулю.
   */
  private completeWindow(prepared: BoundedPreparedReplication): void {
    this.progress.afterSequence = prepared.selection.nextSequence;
    if (this.progress.publicationWindow) {
      this.progress.publicationWindow = { ...this.progress.publicationWindow, completed: true };
    }
    this.save();
  }

  /**
   * Обновляет общую диагностику одного цикла. refresh не вызывает prepare, accept или push.
   */
  private async cycle(refreshOnly: boolean): Promise<void> {
    this.progress.lastAttempt = new Date().toISOString();
    this.progress.attemptId = crypto.randomUUID();
    this.progress.nextRetry = null;
    try {
      if (refreshOnly) {
        const remote = await this.remote(false);
        if (remote.head) {
          await this.repository.rememberRemote(remote.head);
        }
        this.progress.git = await this.repository.counts();
      } else {
        await this.publish();
      }
      this.progress.phase = "idle";
      this.progress.error = null;
    } catch (error) {
      this.progress.error = {
        ...failure(error).error,
        at: new Date().toISOString(),
        operation: this.progress.phase,
      };
      this.progress.phase = "error";
      throw error;
    } finally {
      this.progress.nextRetry = null;
      this.save();
    }
  }
}
