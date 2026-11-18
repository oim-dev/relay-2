import {
  RelayError,
  componentIdentity,
  componentFields,
  componentCollection,
  assertPortableComponentShape,
  isPortableIdentityText,
  type PortableComponent,
  type PortableProjectSnapshot,
} from "@relay/contracts";
import { replicationFingerprint } from "@relay/storage";
import { replicationMessages } from "./replication.messages";

/**
 * После общего shape decoder проверяет уникальность scoped IDs и содержательные версии частей.
 */
export function assertComponents(value: unknown): asserts value is readonly PortableComponent[] {
  if (!Array.isArray(value)) {
    throw new RelayError("REPLICATION_FORMAT", replicationMessages.format, 2, {
      path: "components",
    });
  }
  const seen = new Set<string>();
  for (const component of value) {
    assertPortableComponentShape(component);
    if (!component.ownerId || !component.id) {
      throw new RelayError("REPLICATION_FORMAT", replicationMessages.format, 2, {
        path: "component",
      });
    }
    if (
      (component.kind === "address-assignment" && !isPortableIdentityText(component.value.ref)) ||
      ((component.kind === "task-criterion" ||
        component.kind === "plan-stage" ||
        component.kind === "session-run" ||
        component.kind === "document-section") &&
        component.value.id !== component.id) ||
      (component.kind === "section-reservation" && component.value.sectionId !== component.id) ||
      (component.kind === "collection" && component.value.field !== component.id)
    ) {
      throw new RelayError("REPLICATION_FORMAT", replicationMessages.format, 2, {
        path: "component.value.identity",
      });
    }
    const { version, ...payload } = component;
    const key = componentIdentity(component);
    if (seen.has(key) || version !== replicationFingerprint(payload)) {
      throw new RelayError("REPLICATION_FORMAT", replicationMessages.format, 2, {
        path: "component.version",
        key,
      });
    }
    seen.add(key);
  }
}

/**
 * Не допускает вторую истину collections в owner и компонентов без владельца.
 */
export function validateComponentOwners(snapshot: PortableProjectSnapshot): void {
  if (snapshot.modelVersion !== 2) {
    return;
  }
  assertComponents(snapshot.components);
  const owners = new Map(snapshot.entities.map((entry) => [entry.record.id, entry.record]));
  for (const record of owners.values()) {
    if (componentFields(record.kind).some((field) => Object.hasOwn(record.data, field))) {
      throw new RelayError("REPLICATION_FORMAT", replicationMessages.format, 2, {
        path: "record.data.collections",
        id: record.id,
      });
    }
  }
  for (const part of snapshot.components ?? []) {
    const owner = owners.get(part.ownerId);
    if (owner === undefined) {
      throw new RelayError("REPLICATION_FORMAT", replicationMessages.format, 2, {
        path: "component.ownerId",
        id: part.id,
      });
    }
    const collection = componentCollection(part);
    if (collection !== null && !componentFields(owner.kind).includes(collection)) {
      throw new RelayError("REPLICATION_FORMAT", replicationMessages.format, 2, {
        path: "component.kind.owner",
        id: part.id,
      });
    }
  }
  const assignments = (snapshot.components ?? [])
    .filter((part) => part.kind === "address-assignment" && !part.deleted)
    .map(
      (part) => [part.kind === "address-assignment" ? part.value.ref : "", part.ownerId] as const,
    );
  const actual = new Map(assignments);
  if (
    actual.size !== assignments.length ||
    actual.size !== snapshot.addresses.length ||
    snapshot.addresses.some((entry) => actual.get(entry.ref) !== entry.entityId)
  ) {
    throw new RelayError("REPLICATION_FORMAT", replicationMessages.format, 2, {
      path: "components.addresses",
    });
  }
}
