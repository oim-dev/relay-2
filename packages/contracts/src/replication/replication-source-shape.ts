import type { ReplicationChangeset, ReplicationTransition } from "./replication.types";
import {
  assertPortableComponentShape,
  assertPortableEntityShape,
  assertReplicationAdditionsShape,
} from "./replication-record-shape";
import { assertReplicationPredicatesShape } from "./replication-predicate-shape";
import {
  invalidReplicationShape,
  shapeArray,
  shapeDigest,
  shapeFields,
  shapeIdentity,
  shapeInteger,
  shapeNullableDigest,
  shapeNullableIdentity,
  shapeObject,
  shapeText,
} from "./replication-shape-values";

/**
 * Проверяет полный закрытый JSON changeset без адаптации source, вычисления digest и causal правил.
 * Модель определяет только допустимую форму primary record; обязательность tape проверяет Core.
 * Вход и исторические квитанции не меняются; отказ формы — REPLICATION_FORMAT с details.path.
 */
export function assertReplicationChangesetShape(
  value: unknown,
): asserts value is ReplicationChangeset {
  const source = shapeObject(value, "source");
  shapeFields(
    source,
    [
      "formatVersion",
      "projectId",
      "digest",
      "mode",
      "id",
      "replicaId",
      "sequence",
      "createdAt",
      "dependencies",
      "readContext",
      "entities",
      "addresses",
      "comments",
      "receipts",
    ],
    ["modelVersion", "components", "transitions"],
  );
  if (
    source.formatVersion !== 1 ||
    (source.mode !== "baseline" && source.mode !== "mutation") ||
    (Object.hasOwn(source, "modelVersion") && source.modelVersion !== 2)
  ) {
    invalidReplicationShape("source.format");
  }
  for (const field of ["projectId", "id", "replicaId", "createdAt"]) {
    shapeIdentity(source[field], `source.${field}`);
  }
  shapeDigest(source.digest, "source.digest");
  shapeInteger(source.sequence, "source.sequence", 1);
  for (const dependency of shapeArray(source.dependencies, "dependencies")) {
    shapeIdentity(dependency, "dependency");
  }
  assertEffectsShape(source, source.modelVersion !== 2);
  if (Object.hasOwn(source, "transitions")) {
    for (const step of shapeArray(source.transitions, "transitions")) {
      assertReplicationTransitionShape(step);
    }
  }
}

/**
 * Проверяет полную JSON-форму ordered boundary, не подтверждая команду, авторство, targets или effects.
 * Предметные роли и допустимость перехода проверяет Core после этой общей транспортной границы.
 */
export function assertReplicationTransitionShape(
  value: unknown,
): asserts value is ReplicationTransition {
  const transition = shapeObject(value, "transition");
  shapeFields(
    transition,
    [
      "command",
      "actor",
      "entities",
      "components",
      "addresses",
      "comments",
      "receipts",
      "readContext",
    ],
    ["timestamp", "targets", "predicates"],
  );
  shapeText(transition.command, "transition.command");
  shapeText(transition.actor, "transition.actor");
  if (Object.hasOwn(transition, "timestamp")) {
    shapeText(transition.timestamp, "transition.timestamp");
  }
  assertEffectsShape(transition, false);
  if (Object.hasOwn(transition, "targets")) {
    const targets = shapeObject(transition.targets, "targets");
    shapeFields(targets, ["primaryId", "ownerIds"], ["roles"]);
    shapeNullableIdentity(targets.primaryId, "targets.primaryId");
    for (const ownerId of shapeArray(targets.ownerIds, "targets.ownerIds")) {
      shapeIdentity(ownerId, "targets.ownerIds");
    }
    if (Object.hasOwn(targets, "roles")) {
      for (const id of Object.values(shapeObject(targets.roles, "targets.roles"))) {
        shapeNullableIdentity(id, "targets.roles");
      }
    }
  }
  if (Object.hasOwn(transition, "predicates")) {
    assertReplicationPredicatesShape(transition.predicates);
  }
}

/**
 * Проверяет поля delta/transition до типизации, без сверки совпадения ID, content versions и родителей.
 */
function assertEffectsShape(
  value: Readonly<Record<string, unknown>>,
  legacyRevision: boolean,
): void {
  for (const entry of shapeArray(value.entities, "entities")) {
    const change = shapeObject(entry, "entity.change");
    shapeFields(change, ["id", "before", "after"]);
    shapeIdentity(change.id, "entity.change.id");
    for (const side of [change.before, change.after]) {
      if (side !== null) {
        assertPortableEntityShape(side, legacyRevision);
      }
    }
  }
  if (Object.hasOwn(value, "components")) {
    for (const entry of shapeArray(value.components, "components")) {
      const change = shapeObject(entry, "component.change");
      shapeFields(change, ["key", "before", "after"]);
      shapeIdentity(change.key, "component.change.key");
      if (change.before !== null) {
        assertPortableComponentShape(change.before);
      }
      assertPortableComponentShape(change.after);
    }
  }
  assertReplicationAdditionsShape(value);
  for (const entry of shapeArray(value.readContext, "readContext")) {
    const guard = shapeObject(entry, "readContext.guard");
    shapeFields(guard, ["id", "kind", "version", "sourceChangesetId"], ["logicalDigest"]);
    shapeIdentity(guard.id, "guard.id");
    if (guard.kind !== "existence" && guard.kind !== "content") {
      invalidReplicationShape("guard.kind");
    }
    shapeNullableDigest(guard.version, "guard.version");
    shapeNullableIdentity(guard.sourceChangesetId, "guard.sourceChangesetId");
    if (Object.hasOwn(guard, "logicalDigest")) {
      shapeDigest(guard.logicalDigest, "guard.logicalDigest");
    }
  }
}
