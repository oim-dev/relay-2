import type { ReplicationPublication } from "./replication.types";
import { assertPortableReplicationResolutionShape } from "./replication-resolution-shape";
import {
  assertReplicationChangesetShape,
  assertReplicationTransitionShape,
} from "./replication-source-shape";
import {
  invalidReplicationShape,
  shapeArray,
  shapeDigest,
  shapeFields,
  shapeIdentity,
  shapeNullableDigest,
  shapeObject,
} from "./replication-shape-values";

/**
 * Проверяет полный закрытый JSON publication до типизированного использования Core или Storage.
 * Это только форма: digest, причинность, соответствие accepted/effects и предметные переходы не проверяются.
 * Source, решения, строки квитанций и порядок массивов сохраняются дословно; вход не меняется.
 * Неверная форма даёт REPLICATION_FORMAT с details.path, без доступа к runtime или хранилищу.
 */
export function assertReplicationPublicationShape(
  value: unknown,
): asserts value is ReplicationPublication {
  const publication = shapeObject(value, "publication");
  shapeFields(publication, [
    "formatVersion",
    "publicationId",
    "parent",
    "snapshotDigest",
    "accepted",
    "changes",
  ]);
  if (publication.formatVersion !== 1) {
    invalidReplicationShape("publication.formatVersion");
  }
  shapeDigest(publication.publicationId, "publicationId");
  shapeDigest(publication.snapshotDigest, "snapshotDigest");
  if (publication.parent !== null) {
    const parent = shapeObject(publication.parent, "publication.parent");
    shapeFields(parent, ["publicationId", "snapshotDigest"]);
    shapeNullableDigest(parent.publicationId, "parent.publicationId");
    shapeDigest(parent.snapshotDigest, "parent.snapshotDigest");
  }
  for (const entry of shapeArray(publication.accepted, "accepted")) {
    const accepted = shapeObject(entry, "accepted");
    shapeFields(accepted, ["changesetId", "sourceDigest", "resolutionId", "effectDigest"]);
    shapeIdentity(accepted.changesetId, "accepted.changesetId");
    shapeDigest(accepted.sourceDigest, "accepted.sourceDigest");
    shapeNullableDigest(accepted.resolutionId, "accepted.resolutionId");
    shapeDigest(accepted.effectDigest, "accepted.effectDigest");
  }
  for (const entry of shapeArray(publication.changes, "changes")) {
    const change = shapeObject(entry, "change");
    shapeFields(change, ["source", "resolution", "transitions"]);
    assertReplicationChangesetShape(change.source);
    if (change.resolution !== null) {
      assertPortableReplicationResolutionShape(change.resolution);
    }
    for (const transition of shapeArray(change.transitions, "transitions")) {
      assertReplicationTransitionShape(transition);
    }
  }
}
