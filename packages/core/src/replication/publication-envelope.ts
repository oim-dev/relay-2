import {
  RelayError,
  assertReplicationPublicationShape,
  type PortableProjectSnapshot,
} from "@relay/contracts";
import { replicationFingerprint } from "@relay/storage";
import { publicationIdentity, snapshotDigest } from "./publication-identity";
import { assertPublicationSource, assertReplicationTransition } from "./publication-source";
import { replicationMessages } from "./replication.messages";
import { assertReplicationResolution } from "./resolution-validation";

/**
 * После общего shape decoder Contracts проверяет самосогласованность checkpoint.
 * Форма не является доказательством пропущенной истории.
 * Bootstrap может пропустить replay только при явном доверии приложения к checkpoint Git history.
 */
export function validatePublicationEnvelope(snapshot: PortableProjectSnapshot): void {
  const publication: unknown = snapshot.publication;
  if (publication === null || publication === undefined) {
    throw new RelayError(
      "REPLICATION_PUBLICATION_REQUIRED",
      replicationMessages.publicationRequired,
      4,
    );
  }
  assertReplicationPublicationShape(publication);
  if (
    publication.changes.length === 0 ||
    publication.changes.length !== publication.accepted.length
  ) {
    throw new RelayError(
      "REPLICATION_PUBLICATION_REQUIRED",
      replicationMessages.publicationRequired,
      4,
    );
  }
  const { publicationId, ...payload } = publication;
  if (
    publicationIdentity(payload) !== publicationId ||
    publication.snapshotDigest !== snapshotDigest(snapshot)
  ) {
    throw new RelayError("REPLICATION_PUBLICATION", replicationMessages.publication, 4);
  }
  const ids = new Set<string>();
  for (const [index, change] of publication.changes.entries()) {
    assertPublicationSource(change.source);
    for (const transition of change.transitions) {
      assertReplicationTransition(transition, snapshot.projectId, snapshot.modelVersion === 2);
    }
    if (change.resolution !== null) {
      assertReplicationResolution(change.resolution, snapshot.projectId);
    }
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
