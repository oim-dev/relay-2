import {
  RelayError,
  type PortableProjectSnapshot,
  type PublicationChange,
  type ReplicationHistoryInput,
  type ReplicationPublication,
} from "@relay/contracts";
import { canonicalJson, replicationFingerprint } from "@relay/storage";
import { isConfirmed, retainsConfirmations } from "./confirmations";
import { applyPublicationChange } from "./publication-effects";
import { publicationIdentity, publicationParent, snapshotDigest } from "./publication-identity";
import { canonicalSnapshot } from "./snapshot-canonical";
import { validateAcceptedEvolution } from "./snapshot-merge";
import { replicationMessages } from "./replication.messages";
import { validatePublicationEnvelope } from "./publication-envelope";
import { validateResolution } from "./resolution-validation";
import {
  isVerifiedPublication,
  publicationValidationKey,
  rememberVerifiedPublication,
} from "./publication-validation-cache";
import {
  decodeReplicationSnapshot,
  isDecodedReplicationSnapshot,
  replicationSnapshotKey,
} from "./snapshot-decoder";
import {
  hasVerifiedReplicationHistory,
  rememberReplicationHistory,
} from "./replication-history-proof";

/**
 * Привязывает compact proof каждого нового source к единственной проверяемой публикации.
 * Текущий snapshot содержит только её материал; предыдущие publication остаются в Git history.
 */
export function publishChanges(
  parent: PortableProjectSnapshot,
  result: PortableProjectSnapshot,
  changes: readonly PublicationChange[],
): PortableProjectSnapshot {
  if (changes.length === 0) {
    return parent;
  }
  const accepted = changes.map((change) => ({
    changesetId: change.source.id,
    sourceDigest: change.source.digest,
    resolutionId: change.resolution?.resolutionId ?? null,
    effectDigest: replicationFingerprint(change.transitions),
  }));
  const bindings = new Map(
    accepted.map((entry, index) => [
      entry.changesetId,
      {
        ...entry,
        outcome:
          changes[index]?.resolution?.choice === "remote"
            ? ("discarded" as const)
            : ("applied" as const),
      },
    ]),
  );
  const snapshot = canonicalSnapshot({
    ...result,
    confirmations: result.confirmations.map((entry) => ({
      ...entry,
      proofs: (entry.proofs ?? []).map((proof) => {
        const binding = bindings.get(`${entry.replicaId}:${proof.sequence}`);
        return binding === undefined
          ? proof
          : {
              ...proof,
              resolutionId: binding.resolutionId,
              effectDigest: binding.effectDigest,
              outcome: binding.outcome,
            };
      }),
    })),
  });
  const content: Omit<ReplicationPublication, "publicationId"> = {
    formatVersion: 1,
    parent: publicationParent(parent),
    snapshotDigest: snapshotDigest(snapshot),
    accepted,
    changes,
  };
  const publication = { ...content, publicationId: publicationIdentity(content) };
  return {
    ...snapshot,
    publication,
    confirmations: snapshot.confirmations.map((entry) => ({
      ...entry,
      proofs: (entry.proofs ?? []).map((proof) =>
        bindings.has(`${entry.replicaId}:${proof.sequence}`)
          ? { ...proof, publicationId: publication.publicationId }
          : proof,
      ),
    })),
  };
}

/**
 * Проверяет один непосредственный canonical transition, не исполняя исходные команды повторно.
 */
export function validatePublication(
  parent: PortableProjectSnapshot,
  remote: PortableProjectSnapshot,
): void {
  if (!isDecodedReplicationSnapshot(remote)) {
    validatePublicationEnvelope(remote);
  }
  const publication = remote.publication;
  if (
    publication === null ||
    publication === undefined ||
    canonicalJson(publication.parent) !== canonicalJson(publicationParent(parent))
  ) {
    throw new RelayError(
      "REPLICATION_PUBLICATION_REQUIRED",
      replicationMessages.publicationRequired,
      4,
      {
        accepted: publicationParent(parent),
        requiredParent: publication?.parent ?? null,
      },
    );
  }
  let candidate = parent;
  const changes: PublicationChange[] = [];
  const ids = new Set<string>();
  for (const change of publication.changes) {
    if (
      ids.has(change.source.id) ||
      isConfirmed(candidate.confirmations, change.source.id) ||
      change.source.dependencies.some((id: string) => !isConfirmed(candidate.confirmations, id))
    ) {
      throw new RelayError("REPLICATION_PUBLICATION", replicationMessages.publication, 4);
    }
    ids.add(change.source.id);
    if (change.resolution !== null) {
      validateResolution(change.resolution, change.source, parent);
    }
    const prepared = applyPublicationChange(candidate, change.source, change.resolution);
    if (canonicalJson(prepared.change.transitions) !== canonicalJson(change.transitions)) {
      throw new RelayError("REPLICATION_PUBLICATION", replicationMessages.publication, 4, {
        changesetId: change.source.id,
      });
    }
    candidate = prepared.snapshot;
    changes.push(prepared.change);
  }
  const expected = publishChanges(parent, candidate, changes);
  if (canonicalJson(expected) !== canonicalJson(canonicalSnapshot(remote))) {
    throw new RelayError("REPLICATION_PUBLICATION", replicationMessages.publication, 4);
  }
  if (!retainsConfirmations(parent.confirmations, remote.confirmations)) {
    throw new RelayError("REPLICATION_REGRESSION", replicationMessages.regression, 4);
  }
  validateAcceptedEvolution(parent.entities.length === 0 ? null : parent, remote);
}

/**
 * Проверяет непрерывный путь от принятого предка; пропущенная история никогда не заменяется doctor.
 * already accepted snapshot допускается идемпотентно только при полном совпадении данных и proof.
 */
export function validatePublicationChain(
  base: PortableProjectSnapshot | null,
  remote: PortableProjectSnapshot,
  input: ReplicationHistoryInput = {},
): readonly PortableProjectSnapshot[] {
  const accepted = base === null ? null : decodeReplicationSnapshot(base);
  remote = decodeReplicationSnapshot(remote);
  if (hasVerifiedReplicationHistory(accepted, remote)) {
    return [remote];
  }
  let parent: PortableProjectSnapshot = accepted ?? {
    formatVersion: 1,
    modelVersion: 2,
    projectId: remote.projectId,
    entities: [],
    components: [],
    addresses: [],
    comments: [],
    receipts: [],
    confirmations: [],
    publication: null,
  };
  const checked: PortableProjectSnapshot[] = [];
  let chain = [...(input.chain ?? [])];
  const baseIndex =
    accepted?.publication == null
      ? -1
      : chain.findIndex(
          (entry) => entry.publication?.publicationId === accepted.publication?.publicationId,
        );
  if (baseIndex >= 0) {
    chain = chain.slice(baseIndex + 1);
  }
  if (
    chain.at(-1)?.publication?.publicationId !== remote.publication?.publicationId ||
    chain.length === 0
  ) {
    chain.push(remote);
  }
  for (const value of chain) {
    const step = decodeReplicationSnapshot(value);
    const cacheKey = publicationValidationKey(parent, step);
    if (isVerifiedPublication(cacheKey)) {
      parent = step;
      checked.push(step);
      continue;
    }
    if (step.projectId !== remote.projectId) {
      throw new RelayError("REPLICATION_PROJECT", replicationMessages.project, 4);
    }
    if (
      parent.publication?.publicationId === step.publication?.publicationId &&
      replicationSnapshotKey(parent) === replicationSnapshotKey(step)
    ) {
      checked.push(step);
      continue;
    }
    validatePublication(parent, step);
    rememberVerifiedPublication(cacheKey);
    parent = step;
    checked.push(step);
  }
  if (replicationSnapshotKey(parent) !== replicationSnapshotKey(remote)) {
    throw new RelayError("REPLICATION_PUBLICATION", replicationMessages.publication, 4);
  }
  rememberReplicationHistory(accepted, remote, checked);
  return checked;
}
