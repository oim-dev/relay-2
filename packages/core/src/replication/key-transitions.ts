import {
  componentIdentity,
  type PortableComponent,
  type PortableEntity,
  type PortableProjectSnapshot,
  type ReplicationReadGuard,
  type ReplicationTransition,
} from "@relay/contracts";
import { portableEntity, replicationFingerprint } from "@relay/storage";
import { versionComponent } from "./component-merge";
import { logicalRecord } from "./snapshot-records";
import type { ResolvedReplicationKeyAssignment } from "./key-collisions.types";
import type { ReplicationKeyTransitionContext } from "./key-transitions.types";

/**
 * Индексирует однозначные замены один раз для всей исходной ленты.
 */
export function createKeyTransitionContext(
  assignments: readonly ResolvedReplicationKeyAssignment[],
): ReplicationKeyTransitionContext {
  return {
    replacements: new Map(
      assignments.map((entry) => [JSON.stringify([entry.entityId, entry.fromKey]), entry.key]),
    ),
    originals: new Map(
      assignments.map((entry) => [JSON.stringify([entry.entityId, entry.key]), entry.fromKey]),
    ),
    records: new Map(),
  };
}

/**
 * Производит адресную версию стороны, сохраняя ID, данные, авторство и timestamps.
 * Последующие before переиспользуют уже рассчитанную after; исходная версия остаётся предком.
 */
function rewriteEntityKey(
  entity: PortableEntity | null,
  context: ReplicationKeyTransitionContext,
  rewrittenBefore?: PortableEntity,
): PortableEntity | null {
  if (entity === null) {
    return null;
  }
  const known = context.records.get(entity.version);
  if (known !== undefined) {
    return known;
  }
  const key = context.replacements.get(JSON.stringify([entity.record.id, entity.record.key]));
  if (key === undefined && rewrittenBefore === undefined) {
    return entity;
  }
  const rewritten = portableEntity({ ...entity.record, key: key ?? entity.record.key }, [
    entity.version,
    ...(rewrittenBefore === undefined ? [] : [rewrittenBefore.version]),
  ]);
  context.records.set(entity.version, rewritten);
  return rewritten;
}

/**
 * Меняет только новую address-assignment часть; чужой исходный адрес не становится alias.
 * Новый ID детерминирован от исходной заявки и выбранного адреса.
 */
function rewriteAddressPart(
  part: PortableComponent,
  context: ReplicationKeyTransitionContext,
  before?: PortableComponent,
): PortableComponent {
  if (part.kind !== "address-assignment") {
    return part;
  }
  const key = context.replacements.get(JSON.stringify([part.ownerId, part.value.ref]));
  if (key === undefined) {
    return part;
  }
  return versionComponent(
    {
      ...part,
      id: replicationFingerprint({ assignment: part.id, ref: key }),
      value: { ref: key },
    },
    before === undefined ? [] : [before.version],
  );
}

/**
 * Связывает guard с производной before, не подставляя произвольную свежую сторону.
 * No-op logical digest меняется лишь при точном совпадении после обратной замены ключа;
 * конкурентный текст или состав останутся несовместимыми с исходным наблюдением.
 */
function rewriteKeyReadGuard(
  guard: ReplicationReadGuard,
  current: PortableEntity | undefined,
  snapshot: PortableProjectSnapshot,
  context: ReplicationKeyTransitionContext,
): ReplicationReadGuard {
  if (guard.kind !== "content" || current === undefined) {
    return guard;
  }
  const rewritten = guard.version === null ? undefined : context.records.get(guard.version);
  const original = context.originals.get(JSON.stringify([guard.id, current.record.key]));
  if (original !== undefined && guard.logicalDigest !== undefined) {
    const record = portableEntity(logicalRecord(current, snapshot)).record;
    if (replicationFingerprint({ ...record, key: original }) === guard.logicalDigest) {
      return {
        ...guard,
        version: rewritten?.version ?? current.version,
        logicalDigest: replicationFingerprint(record),
      };
    }
  }
  return rewritten === undefined ? guard : { ...guard, version: rewritten.version };
}

/**
 * Строит effective boundary с согласованной адресацией before/after, частей и технических чтений.
 * Поздний исходный rename сохраняется; произвольные тексты, snapshots внутри data и receipts дословны.
 * Контекст производных версий пополняется; переданная исходная boundary не меняется.
 */
export function applyKeyResolutionToTransition(
  step: ReplicationTransition,
  previous: PortableProjectSnapshot,
  context: ReplicationKeyTransitionContext,
): ReplicationTransition {
  const current = new Map(previous.entities.map((entry) => [entry.record.id, entry]));
  const entities = step.entities.map((change) => {
    const before = rewriteEntityKey(change.before, context);
    const after = rewriteEntityKey(
      change.after,
      context,
      before !== null && before !== change.before ? before : undefined,
    );
    return { ...change, before, after };
  });
  const readContext = step.readContext.map((guard) =>
    rewriteKeyReadGuard(guard, current.get(guard.id), previous, context),
  );
  const versions = new Map(
    step.readContext.flatMap((guard, index) => {
      const version = readContext[index]?.version;
      return version == null || guard.version === version
        ? []
        : [[JSON.stringify([guard.id, guard.version]), version] as const];
    }),
  );
  return {
    ...step,
    entities,
    components: step.components.map((change) => {
      const before = change.before === null ? null : rewriteAddressPart(change.before, context);
      const after =
        before !== null && change.before?.version === change.after.version
          ? before
          : rewriteAddressPart(change.after, context, before ?? undefined);
      return { key: componentIdentity(after), before, after };
    }),
    addresses: step.addresses.map((entry) => ({
      ...entry,
      ref: context.replacements.get(JSON.stringify([entry.entityId, entry.ref])) ?? entry.ref,
    })),
    readContext,
    ...(step.predicates === undefined
      ? {}
      : {
          predicates: step.predicates.map((predicate) => ({
            ...predicate,
            records: predicate.records.map((record) => ({
              ...record,
              version: versions.get(JSON.stringify([record.id, record.version])) ?? record.version,
            })),
          })),
        }),
  };
}
