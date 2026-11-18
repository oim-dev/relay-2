import {
  RelayError,
  assertPortableReplicationResolutionShape,
  isPortableIdentityText,
  validateActor,
  type PortableReplicationResolution,
  type ReplicationChangeset,
  type PortableProjectSnapshot,
} from "@relay/contracts";
import { canonicalJson, replicationFingerprint } from "@relay/storage";
import { assertSnapshot } from "./snapshot-validation";
import { assertPublicationSource } from "./publication-source";
import { createReplicationConflict, resolutionRemoteDigest } from "./conflict-material";
import { resolutionDecision, validateResolutionScope } from "./replication-resolution";
import { replicationMessages } from "./replication.messages";
import { validateKeyAssignments } from "./key-resolution";

/**
 * После общего shape decoder проверяет авторство, scope и версии сторон immutable resolution material.
 * Проверка формы не заменяет предметные правила и не объявляет material доказательством принятия.
 */
export function assertReplicationResolution(
  value: unknown,
  projectId: string,
): asserts value is PortableReplicationResolution {
  assertPortableReplicationResolutionShape(value);
  if (!isPortableIdentityText(value.actor) || !Number.isFinite(Date.parse(value.createdAt))) {
    throw new RelayError("REPLICATION_FORMAT", replicationMessages.format, 2, {
      path: "resolution",
    });
  }
  validateActor(value.actor);
  const material = value.material;
  assertPublicationSource(material.changeset);
  validateResolutionScope(material.changeset, resolutionDecision(value));
  assertSnapshot({
    formatVersion: 1,
    modelVersion: 2,
    projectId,
    entities: material.local,
    components: material.localComponents ?? [],
    addresses: [],
    comments: material.localComments ?? [],
    receipts: [],
    confirmations: [],
  });
  assertSnapshot({
    formatVersion: 1,
    modelVersion: 2,
    projectId,
    entities: material.remote,
    components: material.remoteComponents ?? [],
    addresses: material.remoteAddresses,
    comments: material.remoteComments,
    receipts: material.remoteReceipts,
    confirmations: [],
  });
}

/**
 * Проверяет identity решения и полный просмотренный материал относительно реального parent.
 */
export function validateResolution(
  resolution: PortableReplicationResolution,
  source: ReplicationChangeset,
  parent: PortableProjectSnapshot,
): void {
  assertReplicationResolution(resolution, parent.projectId);
  const { resolutionId, ...material } = resolution;
  const reviewed = createReplicationConflict(
    resolution.material,
    source,
    {
      ...parent,
      entities: resolution.material.local,
      components: resolution.material.localComponents ?? [],
      comments: resolution.material.localComments ?? [],
    },
    parent,
  );
  if (
    replicationFingerprint(material) !== resolutionId ||
    resolution.changesetId !== source.id ||
    resolution.sourceDigest !== source.digest ||
    resolution.remoteDigest !== resolutionRemoteDigest(source, parent) ||
    resolution.material.id !== source.id ||
    resolution.material.fingerprint !== resolution.fingerprint ||
    canonicalJson(reviewed) !== canonicalJson(resolution.material) ||
    canonicalJson(resolution.material.changeset) !== canonicalJson(source)
  ) {
    throw new RelayError("REPLICATION_PUBLICATION", replicationMessages.publication, 4);
  }
  if (resolution.choice === "keys") {
    validateKeyAssignments(
      source,
      { fingerprint: resolution.fingerprint, assignments: resolution.assignments },
      parent,
      parent,
    );
  }
}
