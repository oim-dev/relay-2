import {
  RelayError,
  isPortableIdentityText,
  validateActor,
  type ReplicationResolution,
  type ReplicationChangeset,
  type PortableProjectSnapshot,
} from "@relay/contracts";
import { canonicalJson, replicationFingerprint } from "@relay/storage";
import { mergeObject } from "./record-merge";
import { assertSnapshot } from "./snapshot-validation";
import { assertPublicationSource } from "./publication-source";
import { createReplicationConflict, resolutionRemoteDigest } from "./conflict-material";
import { resolutionDecision, validateResolutionScope } from "./replication-resolution";
import { replicationMessages } from "./replication.messages";

/**
 * Декодирует immutable resolution material без доверия неизвестным полям или локальным KV.
 */
export function assertReplicationResolution(
  value: unknown,
  projectId: string,
): asserts value is ReplicationResolution {
  if (
    !mergeObject(value) ||
    value.formatVersion !== 1 ||
    !mergeObject(value.material) ||
    typeof value.actor !== "string" ||
    !isPortableIdentityText(value.actor) ||
    typeof value.createdAt !== "string" ||
    !Number.isFinite(Date.parse(value.createdAt)) ||
    typeof value.changesetId !== "string"
  ) {
    throw new RelayError("REPLICATION_FORMAT", replicationMessages.format, 2, {
      path: "resolution",
    });
  }
  validateActor(value.actor);
  for (const field of ["resolutionId", "sourceDigest", "fingerprint", "remoteDigest"]) {
    if (typeof value[field] !== "string" || !/^[a-f0-9]{64}$/.test(value[field])) {
      throw new RelayError("REPLICATION_FORMAT", replicationMessages.format, 2, {
        path: `resolution.${field}`,
      });
    }
  }
  const allowed = [
    "formatVersion",
    "resolutionId",
    "changesetId",
    "sourceDigest",
    "actor",
    "createdAt",
    "remoteDigest",
    "material",
    "fingerprint",
    "choice",
    ...(value.choice === "custom" ? ["patch"] : []),
  ];
  if (Object.keys(value).some((field) => !allowed.includes(field))) {
    throw new RelayError("REPLICATION_FORMAT", replicationMessages.format, 2, {
      path: "resolution.fields",
    });
  }
  const material = value.material;
  for (const field of ["id", "fingerprint", "code", "message"]) {
    if (typeof material[field] !== "string") {
      throw new RelayError("REPLICATION_FORMAT", replicationMessages.format, 2, {
        path: `resolution.material.${field}`,
      });
    }
  }
  assertPublicationSource(material.changeset);
  const resolution = value as unknown as ReplicationResolution;
  validateResolutionScope(material.changeset, resolutionDecision(resolution));
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
  resolution: ReplicationResolution,
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
}
