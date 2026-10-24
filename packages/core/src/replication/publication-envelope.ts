import { RelayError, type PortableProjectSnapshot, type PublicationChange } from "@relay/contracts";
import { replicationFingerprint } from "@relay/storage";
import { publicationIdentity, snapshotDigest } from "./publication-identity";
import { assertPublicationSource, assertReplicationTransition } from "./publication-source";
import { mergeObject } from "./record-merge";
import { replicationMessages } from "./replication.messages";
import { assertReplicationResolution } from "./resolution-validation";

/**
 * Проверяет самосогласованность checkpoint, не объявляя её доказательством пропущенной истории.
 * Bootstrap может пропустить replay только при явном доверии приложения к checkpoint Git history.
 */
export function validatePublicationEnvelope(snapshot: PortableProjectSnapshot): void {
  const value: unknown = snapshot.publication;
  if (
    !mergeObject(value) ||
    value.formatVersion !== 1 ||
    typeof value.publicationId !== "string" ||
    typeof value.snapshotDigest !== "string" ||
    !Array.isArray(value.changes) ||
    !Array.isArray(value.accepted) ||
    value.changes.length === 0 ||
    value.changes.length !== value.accepted.length ||
    !(
      value.parent === null ||
      (mergeObject(value.parent) &&
        typeof value.parent.snapshotDigest === "string" &&
        (value.parent.publicationId === null || typeof value.parent.publicationId === "string"))
    )
  ) {
    throw new RelayError(
      "REPLICATION_PUBLICATION_REQUIRED",
      replicationMessages.publicationRequired,
      4,
    );
  }
  const publication = snapshot.publication;
  if (publication === null || publication === undefined) {
    throw new RelayError("REPLICATION_PUBLICATION", replicationMessages.publication, 4);
  }
  const { publicationId, ...payload } = publication;
  if (
    publicationIdentity(payload) !== publicationId ||
    publication.snapshotDigest !== snapshotDigest(snapshot)
  ) {
    throw new RelayError("REPLICATION_PUBLICATION", replicationMessages.publication, 4);
  }
  const ids = new Set<string>();
  for (const [index, changeValue] of value.changes.entries()) {
    if (
      !mergeObject(changeValue) ||
      !Array.isArray(changeValue.transitions) ||
      !(changeValue.resolution === null || mergeObject(changeValue.resolution))
    ) {
      throw new RelayError("REPLICATION_FORMAT", replicationMessages.format, 2);
    }
    assertPublicationSource(changeValue.source);
    for (const transition of changeValue.transitions) {
      assertReplicationTransition(transition, snapshot.projectId, snapshot.modelVersion === 2);
    }
    if (changeValue.resolution !== null) {
      assertReplicationResolution(changeValue.resolution, snapshot.projectId);
    }
    const change = changeValue as unknown as PublicationChange;
    const accepted = publication.accepted[index];
    const proof = snapshot.confirmations
      .find((entry) => entry.replicaId === change.source.replicaId)
      ?.proofs?.find((entry) => entry.sequence === change.source.sequence);
    if (
      ids.has(change.source.id) ||
      accepted?.changesetId !== change.source.id ||
      accepted.sourceDigest !== change.source.digest ||
      accepted.resolutionId !== (change.resolution?.resolutionId ?? null) ||
      accepted.effectDigest !== replicationFingerprint(change.transitions) ||
      proof?.digest !== accepted.sourceDigest ||
      proof.publicationId !== publicationId ||
      proof.resolutionId !== accepted.resolutionId ||
      proof.effectDigest !== accepted.effectDigest ||
      proof.outcome !== (change.resolution?.choice === "remote" ? "discarded" : "applied")
    ) {
      throw new RelayError("REPLICATION_PUBLICATION", replicationMessages.publication, 4);
    }
    ids.add(change.source.id);
  }
}
