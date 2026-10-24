import {
  RelayError,
  componentIdentity,
  type PortableComponent,
  type ReplicatedComponentChange,
} from "@relay/contracts";
import { replicationFingerprint } from "@relay/storage";
import { mergeValue } from "./record-merge";
import { replicationMessages } from "./replication.messages";

/**
 * Создаёт переносимую версию части из её точного содержания и непосредственных предков.
 */
export function versionComponent(
  component: PortableComponent,
  previous: readonly string[],
): PortableComponent {
  const { version: _version, parents: _parents, ...value } = component;
  const parents = [...new Set(previous)].sort();
  return { ...component, parents, version: replicationFingerprint({ ...value, parents }) };
}

/**
 * Объединяет первичные части независимо по scoped ID; tombstone не превращается в новое включение.
 */
export function mergeComponents(
  existing: readonly PortableComponent[],
  changes: readonly ReplicatedComponentChange[],
  preferLocal: boolean,
): PortableComponent[] {
  const result = new Map(existing.map((entry) => [componentIdentity(entry), entry]));
  for (const change of changes) {
    const remote = result.get(change.key);
    const { before, after } = change;
    if (remote?.version === after.version || after.version === before?.version) {
      continue;
    }
    if (
      after.kind !== "collection" &&
      !after.deleted &&
      (before?.deleted === true || remote?.deleted === true)
    ) {
      throw new RelayError(
        preferLocal || before?.deleted ? "REPLICATION_IMMUTABLE" : "REPLICATION_CONFLICT",
        replicationMessages.immutable,
        4,
        { component: change.key },
      );
    }
    if (remote?.version === before?.version || (remote === undefined && before === null)) {
      result.set(change.key, after);
      continue;
    }
    if (before === null || remote === undefined || before.deleted) {
      throw new RelayError("REPLICATION_CONFLICT", replicationMessages.conflict, 4, {
        component: change.key,
      });
    }
    // Снятие и независимая правка одного включения — конфликт, даже если поля не пересекаются.
    if (after.deleted !== remote.deleted && (after.deleted || remote.deleted) && !preferLocal) {
      throw new RelayError("REPLICATION_CONFLICT", replicationMessages.conflict, 4, {
        component: change.key,
      });
    }
    const value = mergeValue(before.value, after.value, remote.value, "value", preferLocal);
    const position = mergeValue(
      before.position,
      after.position,
      remote.position,
      "position",
      false,
    );
    if (typeof position !== "string" || value === null || typeof value !== "object") {
      throw new RelayError("REPLICATION_CONFLICT", replicationMessages.conflict, 4);
    }
    // kind/owner/id неизменны; mergeValue объединяет только проверенные значения той же ветви.
    const merged = { ...after, value, position } as PortableComponent;
    result.set(change.key, versionComponent(merged, [after.version, remote.version]));
  }
  return [...result.values()];
}
