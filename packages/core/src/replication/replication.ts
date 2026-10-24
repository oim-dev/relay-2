import {
  RelayError,
  validateActor,
  isPortableIdentityText,
  type PortableProjectSnapshot,
  type ReplicationAcceptResult,
  type ReplicationConflict,
  type ReplicationDecision,
  type ReplicationStatus,
  type ReplicationHistoryInput,
  type ReplicationBootstrapOptions,
} from "@relay/contracts";
import {
  replicationFingerprint,
  type ReplicationStore,
  type ReplicationState,
  type ReplicationGuard,
  type ReplicationSourceDigest,
  type ReplicationOutboxRequest,
  planReplicationImport,
} from "@relay/storage";
import type {
  ReplicationContext,
  ReplicationContextLoadOptions,
} from "./replication-context.types";
import { isConfirmed, retainsConfirmations } from "./confirmations";
import { prepareReplication, retainConflictedLocal } from "./replication-preparation";
import { conflictFingerprint, conflictOwnerIds, resolutionRemoteDigest } from "./conflict-material";
import { resolutionLocalSources } from "./resolution-application";
import { assertSnapshot, validateSnapshot } from "./snapshot-validation";
import { canonicalSnapshot, validateAcceptedEvolution } from "./snapshot-merge";
import { replicationMessages } from "./replication.messages";
import { validatePublicationChain } from "./publication";
import { validatePublicationEnvelope } from "./publication-envelope";
import { validateEntityData } from "../entities/entity-validation";
import { assertReplicationDecision, validateResolutionScope } from "./replication-resolution";
import { cachedLocalSnapshot, rememberLocalSnapshot } from "./local-snapshot-cache";
import {
  boundedReplicationResult,
  ownProofSources,
  publicationOutboxRequest,
} from "./replication-selection";
import type {
  BoundedPreparedReplication,
  ReplicationPrepareOptions,
  ReplicationDependencyWait,
} from "./replication-selection.types";
import { dependencyWait } from "./replication-dependencies";
import { decodeReplicationSnapshot, isDecodedReplicationSnapshot } from "./snapshot-decoder";
import {
  consumeReplicationHistory,
  hasVerifiedReplicationHistory,
  isValidatedReplicationHistory,
  type ValidatedReplicationHistory,
  rememberReplicationHistory,
} from "./replication-history-proof";

/**
 * Предметное согласование одной независимой реплики; транспорт, процессы и пути принадлежат приложению.
 * Каждая запись состояния/импорт/ack атомарны; сеть никогда не удерживает транзакцию SQLite.
 */
export class ReplicationService {
  /* Синхронный порт локального unit-of-work; соединением владеет приложение. */
  private readonly db: ReplicationStore;

  /**
   * Подключает сервис к открытому хранилищу без новых ресурсов и сетевых обращений.
   */
  constructor(db: ReplicationStore) {
    this.db = db;
  }

  /**
   * Возвращает точное сохраняемое состояние; не подменяет его пользовательскими effective-проекциями.
   * Полное чтение выполняется только при явном capture, не при каждой предметной записи.
   */
  capture(): PortableProjectSnapshot {
    return canonicalSnapshot(this.db.captureReplication());
  }

  /**
   * Возвращает состояние очереди и конфликтов в одном согласованном снимке без сети.
   */
  status(): ReplicationStatus {
    return this.db.getReplicationStatus();
  }

  /**
   * Готовит remote плюс готовые sources ограниченного SQL-окна, не декодируя остальную очередь.
   * Сохраняет диагностику конфликтов, но не подтверждает очередь и не импортирует кандидат.
   * null обозначает ещё не созданную общую ветку; чужой проект/формат/регресс отклоняются.
   * Транспорт сохраняет selection.nextSequence даже при included=[]; non-FF повторяет исходный курсор.
   * Полный canonical local snapshot и witness выбранного решения имеют отдельную полную стоимость.
   */
  prepare(
    remote: PortableProjectSnapshot | null,
    history: ReplicationHistoryInput | ValidatedReplicationHistory = {},
    options: ReplicationPrepareOptions = {},
  ): BoundedPreparedReplication {
    const request = publicationOutboxRequest(options);
    this.checkRemote(remote);
    remote =
      remote === null || isDecodedReplicationSnapshot(remote) ? remote : canonicalSnapshot(remote);
    const context = this.readContext(remote, history, "pending", request);
    remote = remote === null ? null : decodeReplicationSnapshot(remote);
    const calculated = prepareReplication(
      context.local,
      remote ?? this.emptySnapshot(),
      context.outbox,
      context.decisions,
      context.generation,
      context.decisionOutbox,
    );
    const window = context.window;
    if (window === null) {
      throw new RelayError("REPLICATION_LOCAL_CHANGED", replicationMessages.localChanged, 4);
    }
    const result = boundedReplicationResult(calculated, window, request);
    this.db.transaction(() => {
      this.assertContext(context);
      this.db.updateReplicationState({
        observed: remote,
        conflicts: result.conflicts,
        examined: result.selection.examined,
      });
    });
    if (result.included.length > 0 && isDecodedReplicationSnapshot(result.snapshot)) {
      // Источники уже проверены applyPublicationChange; envelope/state проверены decoder, guard принят.
      rememberReplicationHistory(remote, result.snapshot, [result.snapshot]);
    }
    return result;
  }

  /**
   * Подтверждает только реально опубликованный снимок и согласует его с актуальной очередью.
   * Приложение обязано доказать acceptance общей веткой до вызова. Поздние local writes сохраняются.
   * Повтор не повышает revisions/generation и не создаёт echo; конфликт оставляет свои три стороны.
   */
  accept(
    remote: PortableProjectSnapshot,
    history: ReplicationHistoryInput | ValidatedReplicationHistory = {},
  ): ReplicationAcceptResult {
    this.checkRemote(remote);
    remote = isDecodedReplicationSnapshot(remote) ? remote : canonicalSnapshot(remote);
    const context = this.readContext(remote, history);
    const prepared = prepareReplication(
      context.local,
      remote,
      context.outbox,
      context.decisions,
      context.generation,
    );
    const pendingDecisions = new Set(
      prepared.conflicts
        .filter((entry) => entry.code === "REPLICATION_RESOLUTION_STALE")
        .map((entry) => entry.id),
    );
    const acknowledged = context.outbox
      .filter(
        (change) =>
          isConfirmed(remote.confirmations, change.id) && !pendingDecisions.has(change.id),
      )
      .map((change) => change.id);
    const candidate = retainConflictedLocal(prepared, context.local);
    const reconciled = candidate === remote || this.canReconcile(candidate);
    const importPlan = reconciled ? planReplicationImport(context.local, candidate) : undefined;
    const current = reconciled ? candidate : context.local;
    const conflicts = prepared.conflicts.map((conflict) => {
      const owners = conflictOwnerIds(conflict.changeset);
      const journals = new Set(conflict.changeset.comments.map((entry) => entry.taskId));
      return {
        ...conflict,
        fingerprint: conflictFingerprint(conflict.changeset, current, remote),
        local: current.entities.filter((entry) => owners.has(entry.record.id)),
        localComponents: (current.components ?? []).filter((part) => owners.has(part.ownerId)),
        localComments: current.comments.filter((entry) => journals.has(entry.taskId)),
      };
    });
    const committed = this.db.transaction(() => {
      this.assertContext(context);
      if (reconciled) {
        this.db.importReplication(candidate, importPlan);
      }
      this.db.updateReplicationState({ base: remote, observed: remote, acknowledged, conflicts });
      return {
        value: { acknowledged, generation: this.db.getGeneration(), conflicts, reconciled },
        guard: this.db.getReplicationGuard(),
      };
    });
    if (
      reconciled &&
      context.outbox.length === acknowledged.length &&
      isDecodedReplicationSnapshot(remote)
    ) {
      rememberLocalSnapshot(this.db, remote, committed.guard);
    }
    return committed.value;
  }

  /**
   * Читает сохранённые конфликты; fingerprint проверяется заново при resolve.
   */
  conflicts(): readonly ReplicationConflict[] {
    return this.db.getReplicationConflicts();
  }

  /**
   * Читает заблокированные цепочки как pending с точными причинами, отдельно от конфликтов.
   * Диагностика сканирует полный граф ID/dependencies относительно observed либо принятого base.
   * Полные source effects не загружаются; это явное полное чтение, не bounded prepare.
   */
  blocked(): readonly ReplicationDependencyWait[] {
    return this.db.snapshot(() => {
      const state = this.db.getReplicationState();
      const confirmations = (state.observed ?? state.base)?.confirmations ?? [];
      return this.db.getReplicationOutboxDependencies().flatMap((source) => {
        const waiting = dependencyWait(source, confirmations);
        return waiting === null ? [] : [waiting];
      });
    });
  }

  /**
   * Сохраняет явное решение и готовит первое ограниченное окно с обычными причинными зависимостями.
   * Устаревший fingerprint даёт REPLICATION_STALE; решение не является подтверждением доставки.
   * Проверка scoped witness и решения после непринятых предков требует полного локального overlay.
   */
  resolve(
    conflictId: string,
    decision: ReplicationDecision,
    actor: string,
    options: Pick<ReplicationPrepareOptions, "budget"> = {},
  ): BoundedPreparedReplication {
    validateActor(actor);
    if (!isPortableIdentityText(actor)) {
      throw new RelayError("INVALID_ARGUMENT", replicationMessages.format, 2);
    }
    assertReplicationDecision(decision);
    const context = this.loadContext({ conflicts: true });
    const conflict = context.conflicts.find((entry) => entry.id === conflictId);
    if (conflict === undefined) {
      throw new RelayError("NOT_FOUND", replicationMessages.missing, 3);
    }
    if (conflict.code === "REPLICATION_RESOLUTION_STALE" && decision.choice !== "remote") {
      throw new RelayError("REPLICATION_ALREADY_ACCEPTED", replicationMessages.alreadyAccepted, 4, {
        changesetId: conflictId,
        pendingResolution: conflict.pendingResolution,
      });
    }
    validateResolutionScope(conflict.changeset, decision);
    const remote = context.state.observed ?? this.emptySnapshot();
    if (
      decision.fingerprint !== conflict.fingerprint ||
      decision.fingerprint !== conflictFingerprint(conflict.changeset, context.local, remote)
    ) {
      throw new RelayError("REPLICATION_STALE", replicationMessages.stale, 4);
    }
    const resolution = {
      ...decision,
      formatVersion: 1 as const,
      changesetId: conflictId,
      actor,
      createdAt: new Date().toISOString(),
      sourceDigest: conflict.changeset.digest,
      remoteDigest: resolutionRemoteDigest(conflict.changeset, remote),
      material: conflict,
    };
    const identity = {
      ...resolution,
      id: conflictId,
      resolutionId: replicationFingerprint(resolution),
    };
    const choices = [...context.decisions.filter((entry) => entry.id !== conflictId), identity];
    const stored = {
      ...identity,
      localSources: resolutionLocalSources(conflict.changeset, context.outbox, remote, choices),
    };
    const request = publicationOutboxRequest(options);
    const decisions = [...context.decisions.filter((entry) => entry.id !== conflictId), stored];
    // Проверяем решение вместе с ещё непринятыми предками, даже если они не поместятся в одну публикацию.
    const validated = prepareReplication(
      context.local,
      remote,
      context.outbox,
      decisions,
      context.generation,
    );
    const rejected = validated.conflicts.find((entry) => entry.id === conflictId);
    if (rejected !== undefined) {
      throw new RelayError(rejected.code, rejected.message, 4, {
        conflictId,
        fingerprint: rejected.fingerprint,
      });
    }
    if (validated.deferred.some((entry) => entry.id === conflictId)) {
      throw new RelayError("REPLICATION_DEPENDENCY", replicationMessages.dependency, 4);
    }
    const window = this.db.getReplicationOutboxWindow(request);
    const completeWindow =
      window.changesets.length === context.outbox.length &&
      window.changesets.every(
        (entry, index) =>
          entry.id === context.outbox[index]?.id && entry.digest === context.outbox[index]?.digest,
      );
    const calculated = completeWindow
      ? validated
      : prepareReplication(
          context.local,
          remote,
          window.changesets,
          decisions,
          context.generation,
          context.outbox,
        );
    const prepared = boundedReplicationResult(calculated, window, request);
    return this.db.transaction(() => {
      this.assertContext(context);
      this.db.updateReplicationState({
        conflicts: prepared.conflicts,
        examined: prepared.selection.examined,
        decision: stored,
      });
      return prepared;
    });
  }

  /**
   * Восстанавливает новую createReplica-базу из валидного portable snapshot с исходными ID/receipts.
   * Новая реплика имеет собственный replicaId и пустой outbox; существующие рабочие данные защищены.
   */
  bootstrap(snapshot: PortableProjectSnapshot, options: ReplicationBootstrapOptions = {}): void {
    this.checkRemote(snapshot);
    if (options.trustedCheckpoint !== true) {
      validatePublicationChain(null, canonicalSnapshot(snapshot), options);
    } else {
      validatePublicationEnvelope(snapshot);
    }
    const canonical = decodeReplicationSnapshot(snapshot);
    const guard = this.db.transaction(() => {
      this.db.bootstrapReplication(canonical);
      return this.db.getReplicationGuard();
    });
    rememberLocalSnapshot(this.db, canonical, guard);
  }

  /**
   * Проверяет формат и предметную целостность полученного внешнего снимка до записи.
   */
  private checkRemote(remote: PortableProjectSnapshot | null): void {
    if (remote === null) {
      return;
    }
    if (isDecodedReplicationSnapshot(remote)) {
      if (remote.projectId !== this.db.projectId) {
        throw new RelayError("REPLICATION_PROJECT", replicationMessages.project, 4);
      }
      return;
    }
    validateEntityData(remote);
    assertSnapshot(remote);
    if (remote.projectId !== this.db.projectId) {
      throw new RelayError("REPLICATION_PROJECT", replicationMessages.project, 4);
    }
    validateSnapshot(remote);
  }

  /**
   * Проверяет монотонность уже принятой общей истории по согласованному прочитанному контексту.
   */
  private checkEvolution(
    remote: PortableProjectSnapshot | null,
    state: ReplicationState,
    outbox: readonly ReplicationSourceDigest[],
    verifiedHistory = false,
  ): void {
    if (
      state.base !== null &&
      (remote === null || !retainsConfirmations(state.base.confirmations, remote.confirmations))
    ) {
      throw new RelayError("REPLICATION_REGRESSION", replicationMessages.regression, 4);
    }
    if (remote !== null) {
      if (!verifiedHistory) {
        validateAcceptedEvolution(state.base, remote);
      }
      const own = remote.confirmations.find((entry) => entry.replicaId === state.replicaId);
      if (own?.ranges.some(([, last]) => last > state.sequence)) {
        throw new RelayError("REPLICATION_REGRESSION", replicationMessages.regression, 4);
      }
      const knownOwn = new Map([
        ...(state.base?.confirmations
          .find((entry) => entry.replicaId === state.replicaId)
          ?.proofs?.map((proof) => [proof.sequence, proof.digest] as const) ?? []),
        ...outbox
          .filter((change) => change.replicaId === state.replicaId)
          .map((change) => [change.sequence, change.digest] as const),
      ]);
      if ((own?.proofs ?? []).some((proof) => knownOwn.get(proof.sequence) !== proof.digest)) {
        throw new RelayError("REPLICATION_ACK_MISMATCH", replicationMessages.regression, 4);
      }
      const proofs = new Map<string, string>(
        remote.confirmations.flatMap((entry) =>
          (entry.proofs ?? []).map(
            (proof) => [`${entry.replicaId}:${proof.sequence}`, proof.digest] as const,
          ),
        ),
      );
      for (const change of outbox) {
        if (
          isConfirmed(remote.confirmations, change.id) &&
          proofs.get(change.id) !== change.digest
        ) {
          throw new RelayError("REPLICATION_ACK_MISMATCH", replicationMessages.regression, 4, {
            changesetId: change.id,
          });
        }
      }
    }
  }

  /**
   * Создаёт пустую основу первой публикации; полноценный проект появляется атомарным genesis changeset.
   */
  private emptySnapshot(): PortableProjectSnapshot {
    return {
      formatVersion: 1,
      modelVersion: 2,
      projectId: this.db.projectId,
      entities: [],
      components: [],
      addresses: [],
      comments: [],
      receipts: [],
      confirmations: [],
      publication: null,
    };
  }

  /**
   * Проверяет возможность локального наложения вне блокировки писателя, без импорта и записи.
   * Предметно несовместимое наложение откладывается; неожиданная ошибка не маскируется.
   */
  private canReconcile(snapshot: PortableProjectSnapshot): boolean {
    try {
      validateSnapshot(snapshot);
    } catch (error) {
      if (error instanceof RelayError) {
        return false;
      }
      throw error;
    }
    return true;
  }

  /**
   * Загружает контекст одним snapshot; дальнейший merge не удерживает блокировку писателя.
   */
  private readContext(
    remote: PortableProjectSnapshot | null,
    history: ReplicationHistoryInput | ValidatedReplicationHistory = {},
    capture: "always" | "pending" = "always",
    window?: ReplicationOutboxRequest,
  ): ReplicationContext {
    const context = this.loadContext({
      capture,
      ...(window === undefined ? {} : { window }),
      remote,
    });
    let verified =
      remote !== null &&
      isDecodedReplicationSnapshot(remote) &&
      hasVerifiedReplicationHistory(context.state.base, remote);
    if (remote !== null && isValidatedReplicationHistory(history)) {
      consumeReplicationHistory(history, context.state.base, remote);
      verified = true;
    }
    this.checkEvolution(remote, context.state, context.sources, verified);
    if (remote !== null) {
      if (verified || isValidatedReplicationHistory(history)) {
        return context;
      }
      const observed = context.state.observed;
      const known =
        observed !== null &&
        observed.publication !== undefined &&
        observed.publication !== null &&
        (observed.publication.publicationId === remote.publication?.publicationId ||
          observed.publication.publicationId === remote.publication?.parent?.publicationId ||
          history.chain?.some(
            (entry) => entry.publication?.publicationId === observed.publication?.publicationId,
          ));
      validatePublicationChain(known ? observed : context.state.base, remote, history);
    }
    return context;
  }

  /**
   * Загружает контекст одним snapshot. prepare читает окно, accept/resolve — весь overlay.
   * Полный outbox при выбранном решении нужен для localSources witness, а не для выбора candidate.
   */
  private loadContext(options: ReplicationContextLoadOptions = {}): ReplicationContext {
    return this.db.snapshot(() => {
      const state = this.db.getReplicationState();
      const window =
        options.window === undefined ? null : this.db.getReplicationOutboxWindow(options.window);
      const outbox = window?.changesets ?? this.db.getReplicationOutbox();
      const guard = this.db.getReplicationGuard();
      const generation = guard.generation;
      let decisions = this.db.getReplicationDecisions(
        window === null ? undefined : outbox.map((entry) => entry.id),
      );
      const decisionOutbox =
        window !== null && decisions.length > 0 ? this.db.getReplicationOutbox() : outbox;
      if (decisionOutbox !== outbox) {
        decisions = this.db.getReplicationDecisions();
      }
      return {
        state,
        outbox,
        decisionOutbox,
        window,
        sources: ownProofSources(this.db, state, options.remote, outbox),
        generation,
        decisions,
        conflicts: options.conflicts === true ? this.db.getReplicationConflicts() : [],
        local:
          options.capture === "pending" && outbox.length === 0
            ? (state.base ?? this.emptySnapshot())
            : (cachedLocalSnapshot(this.db, guard) ?? this.capture()),
        token: this.contextToken(guard),
      };
    });
  }

  /**
   * Проверяет загруженный контекст под BEGIN IMMEDIATE до любого эффекта commit/ack.
   * Sequence защищает также receipt-only запись, не меняющую поколение сущностей.
   */
  private assertContext(context: ReplicationContext): void {
    const token = this.contextToken(this.db.getReplicationGuard());
    if (token !== context.token) {
      throw new RelayError("REPLICATION_LOCAL_CHANGED", replicationMessages.localChanged, 4);
    }
  }

  /**
   * Строит guard локального состояния и transport-state, включая принятую базу и решения.
   */
  private contextToken(guard: ReplicationGuard): string {
    return replicationFingerprint(guard);
  }
}
