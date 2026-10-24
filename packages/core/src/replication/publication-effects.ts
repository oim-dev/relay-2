import {
  RelayError,
  componentIdentity,
  type PortableProjectSnapshot,
  type PublicationChange,
  type ReplicationChangeset,
  type ReplicationResolution,
  type ReplicationTransition,
} from "@relay/contracts";
import {
  canonicalJson,
  replicationFingerprint,
  adaptLegacyChangeset,
  portableEntity,
} from "@relay/storage";
import { applyChangeset } from "./snapshot-merge";
import { effectivePredicates } from "./publication-predicates";
import { replicationMessages } from "./replication.messages";
import { assertPublicationSource } from "./publication-source";
import { logicalRecord } from "./snapshot-records";
import {
  resolutionDecision,
  resolutionOverrides,
  validateResolutionScope,
} from "./replication-resolution";

/**
 * Строит точную effective-ленту из различий уже проверенных boundary snapshots.
 */
function effectiveTransition(
  before: PortableProjectSnapshot,
  after: PortableProjectSnapshot,
  source: ReplicationTransition,
): ReplicationTransition {
  const oldEntities = new Map(before.entities.map((entry) => [entry.record.id, entry]));
  const oldParts = new Map(
    (before.components ?? []).map((entry) => [componentIdentity(entry), entry]),
  );
  const oldAddresses = new Map(before.addresses.map((entry) => [entry.ref, entry.entityId]));
  const comments = new Set(before.comments.map((entry) => entry.comment.id));
  const receipts = new Set(before.receipts.map((entry) => entry.operationKey));
  return {
    command: source.command,
    actor: source.actor,
    ...(source.timestamp === undefined ? {} : { timestamp: source.timestamp }),
    ...(source.targets === undefined ? {} : { targets: source.targets }),
    entities: after.entities
      .filter((entry) => oldEntities.get(entry.record.id)?.version !== entry.version)
      .map((entry) => ({
        id: entry.record.id,
        before: oldEntities.get(entry.record.id) ?? null,
        after: entry,
      })),
    components: (after.components ?? [])
      .filter((entry) => oldParts.get(componentIdentity(entry))?.version !== entry.version)
      .map((entry) => ({
        key: componentIdentity(entry),
        before: oldParts.get(componentIdentity(entry)) ?? null,
        after: entry,
      })),
    addresses: after.addresses.filter((entry) => oldAddresses.get(entry.ref) !== entry.entityId),
    comments: after.comments.filter((entry) => !comments.has(entry.comment.id)),
    receipts: after.receipts.filter((entry) => !receipts.has(entry.operationKey)),
    readContext: source.readContext.map((entry) => {
      const record = oldEntities.get(entry.id);
      const { logicalDigest: _logicalDigest, ...guard } = entry;
      return {
        ...guard,
        version: entry.kind === "existence" ? null : (record?.version ?? null),
        ...(entry.logicalDigest === undefined || record === undefined
          ? {}
          : {
              logicalDigest: replicationFingerprint(
                portableEntity(logicalRecord(record, before)).record,
              ),
            }),
      };
    }),
    predicates: effectivePredicates(before, source.predicates),
  };
}

/**
 * Представляет старую transaction-delta как одну консервативно проверяемую границу.
 * Не восстанавливает потерянные промежуточные команды: недоказуемый переход отклонится validator.
 */
function legacyTransition(change: ReplicationChangeset): ReplicationTransition {
  return {
    command: "legacy.atomic",
    actor:
      change.entities.find((entry) => entry.after !== null)?.after?.record.updatedBy ??
      change.comments[0]?.comment.createdBy ??
      "relay:migration",
    entities: change.entities,
    components: change.components ?? [],
    addresses: change.addresses,
    comments: change.comments,
    receipts: change.receipts,
    readContext: change.readContext,
    predicates: [],
  };
}

/**
 * Проверяет неизменный source digest и применяет уже выделенные эффекты в порядке команд.
 * Пользовательские обработчики, ID allocation и часы здесь никогда не вызываются.
 */
export function applyPublicationChange(
  previous: PortableProjectSnapshot,
  source: ReplicationChangeset,
  resolution: ReplicationResolution | null,
): { readonly snapshot: PortableProjectSnapshot; readonly change: PublicationChange } {
  assertPublicationSource(source, previous);
  const { digest, ...payload } = source;
  if (
    replicationFingerprint(payload) !== digest ||
    source.projectId !== previous.projectId ||
    source.id !== `${source.replicaId}:${source.sequence}`
  ) {
    throw new RelayError("REPLICATION_ACK_MISMATCH", replicationMessages.publication, 4, {
      changesetId: source.id,
    });
  }
  if (source.modelVersion === 2 && source.mode !== "baseline" && source.transitions === undefined) {
    throw new RelayError(
      "REPLICATION_TRANSITION_REQUIRED",
      replicationMessages.transitionMissing,
      4,
    );
  }
  const adapted = adaptLegacyChangeset(source, previous);
  if (resolution !== null) {
    validateResolutionScope(source, resolutionDecision(resolution));
  }
  if (
    source.mode === "mutation" &&
    resolution === null &&
    source.entities.length + source.comments.length + source.addresses.length === 0 &&
    !(source.transitions ?? []).some((step) => step.targets !== undefined)
  ) {
    throw new RelayError(
      "REPLICATION_TRANSITION_REQUIRED",
      replicationMessages.transitionMissing,
      4,
    );
  }
  if (resolution?.choice !== "remote") {
    validateAcceptedReads(source, previous);
  }
  const steps = source.transitions ?? [legacyTransition(adapted)];
  let snapshot = previous;
  const transitions: ReplicationTransition[] = [];
  if (resolution?.choice === "remote") {
    const next = applyChangeset(snapshot, source, "remote");
    transitions.push(
      effectiveTransition(snapshot, next, {
        ...legacyTransition(source),
        command: "resolution.remote",
      }),
    );
    snapshot = next;
  } else {
    for (const [index, step] of steps.entries()) {
      const next = applyChangeset(
        snapshot,
        { ...source, ...step },
        resolution?.choice === "local" ? "local" : undefined,
        step,
        resolutionOverrides(resolution, index),
      );
      transitions.push(effectiveTransition(snapshot, next, step));
      snapshot = next;
    }
    // Квитанция формируется после последней команды; она сохраняется отдельной boundary того же changeset.
    if (source.receipts.length > 0) {
      const tail = {
        ...legacyTransition(source),
        command: "receipt",
        entities: [],
        components: [],
        addresses: [],
        comments: [],
        readContext: [],
      };
      const withReceipts = applyChangeset(snapshot, { ...source, ...tail }, undefined);
      if (canonicalJson(withReceipts.receipts) !== canonicalJson(snapshot.receipts)) {
        transitions.push(effectiveTransition(snapshot, withReceipts, tail));
      }
      snapshot = withReceipts;
    }
  }
  const effectDigest = replicationFingerprint(transitions);
  snapshot = {
    ...snapshot,
    confirmations: snapshot.confirmations.map((entry) =>
      entry.replicaId !== source.replicaId
        ? entry
        : {
            ...entry,
            proofs: (entry.proofs ?? []).map((proof) =>
              proof.sequence !== source.sequence
                ? proof
                : {
                    ...proof,
                    effectDigest,
                    resolutionId: resolution?.resolutionId ?? null,
                    outcome: resolution?.choice === "remote" ? "discarded" : "applied",
                  },
            ),
          },
    ),
  };
  return { snapshot, change: { source, resolution, transitions } };
}

/**
 * Отклонение предка не авторизует применение зависимых effects. Явный remote может отклонить и потомка.
 */
function validateAcceptedReads(
  source: ReplicationChangeset,
  previous: PortableProjectSnapshot,
): void {
  const records = new Map(previous.entities.map((entry) => [entry.record.id, entry]));
  for (const guard of source.readContext) {
    const id = guard.sourceChangesetId;
    if (id === null) {
      continue;
    }
    const separator = id.lastIndexOf(":");
    const proof = previous.confirmations
      .find((entry) => entry.replicaId === id.slice(0, separator))
      ?.proofs?.find((entry) => entry.sequence === Number(id.slice(separator + 1)));
    const record = records.get(guard.id);
    if (
      proof?.outcome === "discarded" &&
      (record === undefined || (guard.kind === "content" && record.version !== guard.version))
    ) {
      throw new RelayError("REPLICATION_DEPENDENCY", replicationMessages.dependency, 4, {
        id: guard.id,
        sourceChangesetId: id,
      });
    }
  }
}
