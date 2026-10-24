import {
  assembleComponentRecord,
  componentIdentity,
  type PortableEntity,
  type PortableComponent,
  type PortableProjectSnapshot,
  type ReplicationChangeset,
} from "@relay/contracts";

/**
 * Собирает исходные raw sides только для предметных validators, не создавая вторую экспортную истину.
 */
export function logicalTransitionChangeset(
  change: ReplicationChangeset,
  previous: PortableProjectSnapshot,
  next: PortableProjectSnapshot,
): ReplicationChangeset {
  if (previous.modelVersion !== 2 && next.modelVersion !== 2) {
    return change;
  }
  const beforeParts = new Map(
    (previous.components ?? []).map((part) => [componentIdentity(part), part]),
  );
  const afterParts = new Map(beforeParts);
  const owners = new Set(change.entities.map((entry) => entry.id));
  for (const part of change.components ?? []) {
    owners.add(part.after.ownerId);
    if (part.before === null) {
      beforeParts.delete(part.key);
    } else {
      beforeParts.set(part.key, part.before);
    }
    afterParts.set(part.key, part.after);
  }
  const old = new Map(previous.entities.map((entry) => [entry.record.id, entry]));
  const changes = new Map(change.entities.map((entry) => [entry.id, entry]));
  return {
    ...change,
    entities: [...owners].map((id) => {
      const source = changes.get(id);
      return {
        id,
        before: assembleSide(source === undefined ? (old.get(id) ?? null) : source.before, [
          ...beforeParts.values(),
        ]),
        after: assembleSide(source === undefined ? (old.get(id) ?? null) : source.after, [
          ...afterParts.values(),
        ]),
      };
    }),
  };
}

/**
 * Сохраняет version исходной стороны, временно собирая data для общего предметного декодера.
 */
function assembleSide(
  entry: PortableEntity | null,
  parts: readonly PortableComponent[],
): PortableEntity | null {
  if (entry === null) {
    return null;
  }
  const { revision: _revision, ...record } = assembleComponentRecord(
    { ...entry.record, revision: 1 },
    parts,
  );
  return { ...entry, record };
}
