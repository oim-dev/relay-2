import {
  componentIdentity,
  componentMigrationId,
  componentNaturalIdentity,
  splitComponentRecord,
  type PortableComponent,
  type PortableEntity,
  type PortableProjectSnapshot,
  type ReplicationChangeset,
  type ReplicatedComponentChange,
} from "@relay/contracts";
import { assignComponentPositions } from "../components/component-positions";
import { versionComponent } from "../components/component-store";
import { canonicalJson, portableEntity } from "./portable-version";

/**
 * Версионная адаптация draft-v3 source в нормализованные эффекты, отдельно от immutable payload.
 * Исходный digest/ID/JSON не переписывается; отсутствие ordered tape остаётся явной legacy boundary.
 */
export function adaptLegacyChangeset(
  source: ReplicationChangeset,
  previous: PortableProjectSnapshot,
): ReplicationChangeset {
  if (source.modelVersion === 2) {
    return source;
  }
  const components: ReplicatedComponentChange[] = [];
  const entities = source.entities.map((change) => {
    // Base не выводится из нового remote: иначе retry выдумывал бы причинные parents исходной стороны.
    const before = normalizeLegacyEntity(change.before, []);
    const after = normalizeLegacyEntity(change.after, before.components);
    const current = previous.entities.find((entry) => entry.record.id === change.id);
    const beforeEntity =
      current !== undefined &&
      before.entity !== null &&
      canonicalJson(current.record) === canonicalJson(before.entity.record)
        ? current
        : before.entity;
    const afterEntity =
      current !== undefined &&
      after.entity !== null &&
      canonicalJson(current.record) === canonicalJson(after.entity.record)
        ? current
        : after.entity;
    const beforeParts = new Map(before.components.map((part) => [componentIdentity(part), part]));
    const afterParts = new Map(after.components.map((part) => [componentIdentity(part), part]));
    for (const [key, part] of afterParts) {
      const old = beforeParts.get(key) ?? null;
      if (old?.version !== part.version) {
        components.push({ key, before: old, after: part });
      }
    }
    for (const [key, part] of beforeParts) {
      if (!afterParts.has(key)) {
        components.push({
          key,
          before: part,
          after: versionComponent({ ...part, deleted: true, parents: [part.version] }),
        });
      }
    }
    return { id: change.id, before: beforeEntity, after: afterEntity };
  });
  const parts = previous.components ?? [];
  for (const address of source.addresses) {
    if (
      parts.some(
        (part) =>
          part.kind === "address-assignment" &&
          !part.deleted &&
          part.ownerId === address.entityId &&
          part.value.ref === address.ref,
      )
    ) {
      continue;
    }
    const after = versionComponent({
      id: componentMigrationId(address.entityId, "address-assignment", address.ref),
      kind: "address-assignment",
      ownerId: address.entityId,
      position: "V",
      deleted: false,
      parents: [],
      value: { ref: address.ref },
    });
    components.push({ key: componentIdentity(after), before: null, after });
  }
  // modelVersion остаётся legacy: исходник не получает выдуманный source proof новой модели.
  return { ...source, entities, components };
}

/**
 * Разлагает одну историческую сторону с детерминированными migration IDs и стабильными позициями.
 */
function normalizeLegacyEntity(
  entry: PortableEntity | null,
  previous: readonly PortableComponent[],
): { entity: PortableEntity | null; components: PortableComponent[] } {
  if (entry === null) {
    return { entity: null, components: [] };
  }
  const layout = splitComponentRecord({ ...entry.record, revision: 1 });
  const seeds = layout.seeds.map((seed) => ({
    seed,
    id:
      seed.id ??
      previous.find(
        (part) => part.kind === seed.kind && componentNaturalIdentity(part) === seed.identity,
      )?.id ??
      componentMigrationId(entry.record.id, seed.kind, seed.identity),
  }));
  const positions = new Map<string, string>();
  const groups = new Map<string, typeof seeds>();
  for (const seed of seeds) {
    const key = JSON.stringify([seed.seed.kind, seed.seed.group]);
    const group = groups.get(key) ?? [];
    group.push(seed);
    groups.set(key, group);
  }
  for (const group of groups.values()) {
    const first = group[0];
    if (first === undefined) {
      continue;
    }
    const assigned = assignComponentPositions(
      group.map((item) => item.id),
      previous.filter((part) => part.kind === first.seed.kind),
    );
    for (const seed of group) {
      positions.set(
        JSON.stringify([seed.seed.kind, seed.id]),
        seed.seed.kind === "collection" ? "V" : (assigned.get(seed.id) ?? "V"),
      );
    }
  }
  const components = seeds.map(({ seed, id }) => {
    const old = previous.find((part) => part.kind === seed.kind && part.id === id);
    const position = positions.get(JSON.stringify([seed.kind, id])) ?? "V";
    if (
      old !== undefined &&
      !old.deleted &&
      canonicalJson(old.value) === canonicalJson(seed.value) &&
      old.position === position
    ) {
      return old;
    }
    return versionComponent({
      id,
      kind: seed.kind,
      ownerId: entry.record.id,
      position,
      value: seed.value,
      deleted: false,
      parents: old === undefined ? [] : [old.version],
    } as Omit<PortableComponent, "version">);
  });
  const raw = portableEntity(layout.record, entry.parents ?? []);
  return {
    entity: raw.version === entry.version ? raw : portableEntity(layout.record, [entry.version]),
    components,
  };
}
