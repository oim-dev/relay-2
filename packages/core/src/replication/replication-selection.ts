import { RelayError, type PortableProjectSnapshot } from "@relay/contracts";
import type {
  ReplicationOutboxRequest,
  ReplicationOutboxWindow,
  ReplicationSourceDigest,
  ReplicationState,
  ReplicationStore,
} from "@relay/storage";
import type {
  ReplicationPrepareOptions,
  ReplicationPublicationBudget,
  BoundedPreparedReplication,
  PendingReplicationPreparation,
} from "./replication-selection.types";
import { replicationMessages } from "./replication.messages";
import { sealCalculatedReplicationSnapshot } from "./snapshot-decoder";

/**
 * Верхний бюджет обычной публикации; тесты и вызывающий могут передать меньшие пределы.
 */
export const REPLICATION_PUBLICATION_BUDGET: ReplicationPublicationBudget = Object.freeze({
  maxChangesets: 64,
  maxBytes: 8 * 1024 * 1024,
});

/**
 * Проверяет явные конечные пределы до чтения контекста; никакой unlimited-ветви нет.
 */
export function publicationOutboxRequest(
  options: ReplicationPrepareOptions,
): ReplicationOutboxRequest {
  const request = {
    afterSequence: options.afterSequence ?? 0,
    maxChangesets: options.budget?.maxChangesets ?? REPLICATION_PUBLICATION_BUDGET.maxChangesets,
    maxBytes: options.budget?.maxBytes ?? REPLICATION_PUBLICATION_BUDGET.maxBytes,
  };
  if (
    !Number.isSafeInteger(request.afterSequence) ||
    request.afterSequence < 0 ||
    !Number.isSafeInteger(request.maxChangesets) ||
    request.maxChangesets < 1 ||
    request.maxChangesets > REPLICATION_PUBLICATION_BUDGET.maxChangesets ||
    !Number.isSafeInteger(request.maxBytes) ||
    request.maxBytes < 1 ||
    request.maxBytes > REPLICATION_PUBLICATION_BUDGET.maxBytes
  ) {
    throw new RelayError("INVALID_ARGUMENT", replicationMessages.publicationBudget, 2);
  }
  return request;
}

/**
 * Отделяет публичную ограниченную публикацию от полного материала внутреннего local overlay.
 * Запечатывается только результат проверенного builder; cursor и pending никогда не означают ack.
 */
export function boundedReplicationResult(
  prepared: PendingReplicationPreparation,
  window: ReplicationOutboxWindow,
  request: ReplicationOutboxRequest,
): BoundedPreparedReplication {
  return {
    snapshot:
      prepared.snapshot.entities.length === 0
        ? prepared.snapshot
        : sealCalculatedReplicationSnapshot(prepared.snapshot),
    generation: prepared.generation,
    included: prepared.included,
    conflicts: prepared.conflicts,
    selection: {
      afterSequence: request.afterSequence,
      nextSequence: window.nextSequence,
      hasMore: window.hasMore,
      examined: window.changesets.map((entry) => entry.id),
      deferred: prepared.deferred.map((entry) => entry.id),
      waiting: prepared.waiting,
      pending: window.pending,
      sourceBytes: window.sourceBytes,
      oversized: window.oversized,
    },
  };
}

/**
 * Дополняет выбранные sources только metadata собственных новых remote proofs вне окна.
 * Прежний base уже содержит проверенные digest; остальная очередь не читается и не декодируется.
 */
export function ownProofSources(
  db: ReplicationStore,
  state: ReplicationState,
  remote: PortableProjectSnapshot | null | undefined,
  selected: readonly ReplicationSourceDigest[],
): readonly ReplicationSourceDigest[] {
  const known = new Set([
    ...(state.base?.confirmations
      .find((entry) => entry.replicaId === state.replicaId)
      ?.proofs?.map((entry) => `${state.replicaId}:${entry.sequence}`) ?? []),
    ...selected.map((entry) => entry.id),
  ]);
  const missing =
    remote?.confirmations
      .find((entry) => entry.replicaId === state.replicaId)
      ?.proofs?.map((entry) => `${state.replicaId}:${entry.sequence}`)
      .filter((id) => !known.has(id)) ?? [];
  return missing.length === 0
    ? selected
    : [...selected, ...db.getReplicationOutboxDigests(missing)];
}
