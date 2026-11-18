import type { PortableReplicationResolution } from "./replication.types";
import { assertReplicationChangesetShape } from "./replication-source-shape";
import {
  assertPortableComponentShape,
  assertPortableEntityShape,
  assertReplicationAdditionsShape,
} from "./replication-record-shape";
import {
  invalidReplicationShape,
  shapeArray,
  shapeDigest,
  shapeFields,
  shapeInteger,
  shapeNullableDigest,
  shapeObject,
  shapeText,
} from "./replication-shape-values";

/**
 * Проверяет полную форму immutable решения и просмотренного материала без проверки scope/fingerprint.
 * keys разрешён только в PortableReplicationResolution; pendingResolution сохраняет серверную форму.
 * Вход не изменяется. Циклический material и неверные поля дают REPLICATION_FORMAT.
 */
export function assertPortableReplicationResolutionShape(
  value: unknown,
): asserts value is PortableReplicationResolution {
  assertResolutionShape(value, new Set());
}

/**
 * Проверяет варианты решения; ancestors защищает рекурсивный pendingResolution от циклов не-JSON ввода.
 */
function assertResolutionShape(value: unknown, ancestors: Set<object>): void {
  const resolution = shapeObject(value, "resolution");
  if (ancestors.has(resolution)) {
    invalidReplicationShape("resolution.material.cycle");
  }
  ancestors.add(resolution);
  const required = [
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
  ];
  if (resolution.choice === "custom") {
    required.push("patch");
  } else if (resolution.choice === "keys") {
    required.push("assignments");
  } else if (resolution.choice !== "local" && resolution.choice !== "remote") {
    invalidReplicationShape("resolution.choice");
  }
  shapeFields(resolution, required);
  if (resolution.formatVersion !== 1) {
    invalidReplicationShape("resolution.formatVersion");
  }
  for (const field of ["changesetId", "actor", "createdAt"]) {
    shapeText(resolution[field], `resolution.${field}`);
  }
  for (const field of ["resolutionId", "sourceDigest", "remoteDigest", "fingerprint"]) {
    shapeDigest(resolution[field], `resolution.${field}`);
  }
  if (resolution.choice === "custom") {
    for (const entry of shapeArray(resolution.patch, "patch")) {
      const patch = shapeObject(entry, "patch");
      shapeFields(patch, ["transition", "entityId", "field", "value"]);
      shapeInteger(patch.transition, "patch.transition");
      shapeText(patch.entityId, "patch.entityId");
      shapeText(patch.value, "patch.value");
      if (patch.field !== "name" && patch.field !== "summary" && patch.field !== "body") {
        invalidReplicationShape("patch.field");
      }
    }
  }
  if (resolution.choice === "keys") {
    for (const entry of shapeArray(resolution.assignments, "assignments")) {
      const assignment = shapeObject(entry, "assignment");
      shapeFields(assignment, ["entityId", "key"], ["fromKey"]);
      shapeText(assignment.entityId, "assignment.entityId");
      shapeText(assignment.key, "assignment.key");
      if (Object.hasOwn(assignment, "fromKey")) {
        shapeText(assignment.fromKey, "assignment.fromKey");
      }
    }
  }
  assertConflictShape(resolution.material, ancestors);
  ancestors.delete(resolution);
}

/**
 * Проверяет сохранённые стороны конфликта, не заменяя их текущим состоянием проекта.
 */
function assertConflictShape(value: unknown, ancestors: Set<object>): void {
  const conflict = shapeObject(value, "conflict");
  shapeFields(
    conflict,
    [
      "id",
      "fingerprint",
      "code",
      "message",
      "changeset",
      "local",
      "remote",
      "remoteComments",
      "remoteReceipts",
      "remoteAddresses",
    ],
    [
      "localComponents",
      "remoteComponents",
      "localComments",
      "pendingResolution",
      "acceptedResolutionId",
    ],
  );
  for (const field of ["id", "fingerprint", "code", "message"]) {
    shapeText(conflict[field], `conflict.${field}`);
  }
  assertReplicationChangesetShape(conflict.changeset);
  for (const field of ["local", "remote"]) {
    for (const entity of shapeArray(conflict[field], `conflict.${field}`)) {
      assertPortableEntityShape(entity);
    }
  }
  for (const field of ["localComponents", "remoteComponents"]) {
    if (Object.hasOwn(conflict, field)) {
      for (const component of shapeArray(conflict[field], `conflict.${field}`)) {
        assertPortableComponentShape(component);
      }
    }
  }
  assertReplicationAdditionsShape({
    addresses: conflict.remoteAddresses,
    comments: conflict.remoteComments,
    receipts: conflict.remoteReceipts,
  });
  if (Object.hasOwn(conflict, "localComments")) {
    assertReplicationAdditionsShape({
      addresses: [],
      comments: conflict.localComments,
      receipts: [],
    });
  }
  if (Object.hasOwn(conflict, "pendingResolution")) {
    const pending = shapeObject(conflict.pendingResolution, "pendingResolution");
    if (pending.choice === "keys") {
      invalidReplicationShape("pendingResolution.choice");
    }
    assertResolutionShape(pending, ancestors);
  }
  if (Object.hasOwn(conflict, "acceptedResolutionId")) {
    shapeNullableDigest(conflict.acceptedResolutionId, "conflict.acceptedResolutionId");
  }
}
