import type { Database } from "bun:sqlite";
import {
  RelayError,
  componentIdentity,
  splitComponentRecord,
  type CommandTransition,
  type EntityRecord,
  type PortableComponent,
  type ReplicatedComponentChange,
  type ReplicationPredicate,
  type ReplicationReadGuard,
  type ReplicationTransition,
} from "@relay/contracts";
import { flushComponentVersions } from "../components/component-store";
import { portableEntity, replicationFingerprint } from "./portable-version";
import type {
  ReplicationJsonRow,
  TransitionReadMetadata,
  TransitionComponentEvent,
} from "./replication.types";
import { storageReplicationMessages } from "./replication.messages";

/**
 * Читает только component дельты внешней транзакции; ID снятий остаются tombstones.
 */
export function readComponentChanges(connection: Database): ReplicatedComponentChange[] {
  return connection
    .query<Pick<TransitionComponentEvent, "before_json" | "after_json">, []>(
      "SELECT before_json,after_json FROM component_changes ORDER BY owner_id,kind,id",
    )
    .all()
    .map((row) => {
      const after: PortableComponent = JSON.parse(row.after_json);
      return {
        key: componentIdentity(after),
        before: row.before_json === null ? null : JSON.parse(row.before_json),
        after,
      };
    });
}

/**
 * Читает ordered tape один раз при outer flush; следующие шаги не перечитывают её полные payload.
 */
export function readTransitionQueue(connection: Database): ReplicationTransition[] {
  return connection
    .query<ReplicationJsonRow, []>(
      "SELECT json FROM replication_transition_queue ORDER BY sequence",
    )
    .all()
    .map((row) => JSON.parse(row.json));
}

/**
 * Загружает primary versions/causal heads одним адресным SQL без N+1 и без текстов/журналов.
 * Временные heads предыдущих шагов откатываются тем же savepoint, что данные команды.
 */
function transitionMetadata(
  connection: Database,
  step: CommandTransition,
): ReadonlyMap<string, TransitionReadMetadata> {
  const ids = new Set(step.reads.map((record) => record.id));
  for (const effect of step.effects) {
    ids.add(effect.kind === "entity" ? effect.after.id : effect.taskId);
  }
  for (const { observation } of step.predicates) {
    if (observation.kind === "records") {
      for (const record of observation.records) {
        ids.add(record.id);
      }
    }
    if (observation.kind === "identities") {
      for (const record of observation.identities) {
        if (record !== null) {
          ids.add(record.id);
        }
      }
    }
  }
  return new Map(
    connection
      .query<TransitionReadMetadata, [string]>(
        `
    SELECT wanted.value AS id,coalesce(h.version,v.version) AS version,
      coalesce(h.parents_json,v.parents_json) AS parents_json,
      CASE WHEN h.entity_id IS NULL THEN q.before_json ELSE NULL END AS before_json,
      c.changeset_id AS content_source,x.changeset_id AS existence_source
    FROM json_each(?) wanted LEFT JOIN replication_transition_heads h ON h.entity_id=wanted.value
    LEFT JOIN replication_entity_versions v ON v.entity_id=wanted.value
    LEFT JOIN replication_entity_queue q ON q.id=wanted.value
    LEFT JOIN replication_owner_heads c ON c.owner='entity:'||wanted.value
    LEFT JOIN replication_owner_heads x ON x.owner='existence:'||wanted.value
  `,
      )
      .all(JSON.stringify([...ids]))
      .map((entry) => [entry.id, entry]),
  );
}

/**
 * Выбирает causal основание из уже загруженной меты, не включая локальный CAS.
 */
function readGuard(
  metadata: ReadonlyMap<string, TransitionReadMetadata>,
  id: string,
  kind: ReplicationReadGuard["kind"],
): ReplicationReadGuard {
  const entry = metadata.get(id);
  return {
    id,
    kind,
    version: kind === "existence" ? null : (entry?.version ?? null),
    sourceChangesetId:
      (kind === "existence" ? entry?.existence_source : entry?.content_source) ?? null,
  };
}

/**
 * Сохраняет точную семантику чтения; existence комментария не повышается до content из-за reads[].
 */
function transitionReads(
  step: CommandTransition,
  metadata: ReadonlyMap<string, TransitionReadMetadata>,
): ReplicationReadGuard[] {
  const kinds = new Map<string, ReplicationReadGuard["kind"]>();
  const full = new Map<string, EntityRecord>();
  for (const { selector, observation } of step.predicates) {
    const ids =
      observation.kind === "records"
        ? observation.records.map((entry) => entry.id)
        : observation.kind === "identities"
          ? observation.identities.flatMap((entry) => (entry === null ? [] : [entry.id]))
          : [];
    const kind =
      observation.kind === "identities" ||
      (selector.kind === "entity" && selector.semantic === "existence")
        ? "existence"
        : "content";
    if (selector.kind === "entity" && observation.kind === "records") {
      for (const record of observation.records) {
        full.set(record.id, record);
      }
    }
    for (const id of ids) {
      if (kinds.get(id) !== "content") {
        kinds.set(id, kind);
      }
    }
  }
  for (const record of step.reads) {
    if (!kinds.has(record.id)) {
      kinds.set(record.id, "content");
    }
  }
  return [...kinds].map(([id, kind]) => {
    const record = full.get(id);
    return {
      ...readGuard(metadata, id, kind),
      ...(kind === "content" && record !== undefined
        ? { logicalDigest: replicationFingerprint(portableEntity(record).record) }
        : {}),
    };
  });
}

/**
 * Сохраняет положительные/отрицательные source predicates без локальных fingerprint и previousId ремапа.
 */
function portablePredicates(
  step: CommandTransition,
  metadata: ReadonlyMap<string, TransitionReadMetadata>,
): ReplicationPredicate[] {
  return step.predicates.flatMap(({ selector, observation }) => {
    if (selector.kind === "key" || selector.kind === "summaries") {
      return [];
    }
    const ids =
      observation.kind === "records"
        ? observation.records.map((entry) => entry.id)
        : observation.kind === "identities"
          ? observation.identities.flatMap((entry) => (entry === null ? [] : [entry.id]))
          : [];
    let present: boolean | null = null;
    if (observation.kind === "boolean") {
      present = observation.value;
    }
    if (observation.kind === "address-state") {
      present = observation.currentId !== null;
    }
    if (observation.kind === "receipt") {
      present = observation.receipt !== null;
    }
    const existence =
      observation.kind === "identities" ||
      (selector.kind === "entity" && selector.semantic === "existence");
    return [
      {
        selector,
        present,
        records: [...new Set(ids)]
          .sort()
          .map((id) => ({ id, version: existence ? null : (metadata.get(id)?.version ?? null) })),
      },
    ];
  });
}

/**
 * Схлопывает implicit SQL effects лишь внутри данной command boundary, сохраняя границы между командами.
 * Cursor позволяет читать только новые события; предыдущие тексты компонентов не перечитываются.
 */
function componentBoundary(connection: Database): ReplicatedComponentChange[] {
  const events = connection
    .query<TransitionComponentEvent, []>(
      "SELECT sequence,before_json,after_json FROM component_events WHERE sequence>(SELECT component_sequence FROM replication_transition_cursor WHERE singleton=1) ORDER BY sequence",
    )
    .all();
  const changes = new Map<string, ReplicatedComponentChange>();
  for (const event of events) {
    const after: PortableComponent = JSON.parse(event.after_json);
    const key = componentIdentity(after);
    const prior = changes.get(key);
    const before =
      prior === undefined
        ? event.before_json === null
          ? null
          : JSON.parse(event.before_json)
        : prior.before;
    changes.set(key, { key, before, after });
  }
  const last = events.at(-1);
  if (last !== undefined) {
    connection
      .query("UPDATE replication_transition_cursor SET component_sequence=? WHERE singleton=1")
      .run(last.sequence);
  }
  return [...changes.values()]
    .filter((entry) => entry.before?.version !== entry.after.version)
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

/**
 * Собирает raw owner sides из уже выделенных эффектов и версий непосредственно предыдущей границы.
 */
function entityBoundary(
  step: CommandTransition,
  metadata: ReadonlyMap<string, TransitionReadMetadata>,
): ReplicationTransition["entities"] {
  const effects = new Map<
    string,
    Extract<CommandTransition["effects"][number], { kind: "entity" }>[]
  >();
  for (const effect of step.effects) {
    if (effect.kind !== "entity") {
      continue;
    }
    const entries = effects.get(effect.after.id) ?? [];
    entries.push(effect);
    effects.set(effect.after.id, entries);
  }
  return [...effects].map(([id, entries]) => {
    const first = entries[0];
    const last = entries.at(-1);
    if (first === undefined || last === undefined) {
      throw new Error("REPLICATION_TRANSITION_EMPTY_OWNER");
    }
    const stored = metadata.get(id);
    if (first.before !== null && stored?.parents_json == null) {
      throw new RelayError("CORRUPT_DATA", storageReplicationMessages.corruptVersion, 1, { id });
    }
    const before =
      first.before === null
        ? null
        : portableEntity(
            stored?.before_json == null
              ? splitComponentRecord(first.before).record
              : JSON.parse(stored.before_json),
            JSON.parse(stored?.parents_json ?? "[]"),
          );
    if (before !== null && before.version !== stored?.version) {
      throw new RelayError("CORRUPT_DATA", storageReplicationMessages.corruptVersion, 1, { id });
    }
    const record = splitComponentRecord(last.after).record;
    const unchanged = portableEntity(record, before?.parents ?? []);
    const after =
      before?.version === unchanged.version
        ? before
        : portableEntity(record, before === null ? [] : [before.version]);
    return { id, before, after };
  });
}

/**
 * Захватывает переносимую границу ПОСЛЕ всех effects одной команды и ДО следующей команды.
 * Callback не делает commit, не выдаёт ID/время и читает только новый component event tail и узкую мету.
 */
export function captureCommandTransition(
  connection: Database,
  step: CommandTransition,
  actor: string,
): void {
  flushComponentVersions(connection);
  const metadata = transitionMetadata(connection, step);
  const entities = entityBoundary(step, metadata);
  const components = componentBoundary(connection);
  const addresses = components.flatMap((entry) =>
    entry.before === null && entry.after.kind === "address-assignment" && !entry.after.deleted
      ? [{ ref: entry.after.value.ref, entityId: entry.after.ownerId }]
      : [],
  );
  const commentEffects = step.effects.filter((effect) => effect.kind === "comment");
  const after = new Map(
    connection
      .query<{ id: string; after_id: string | null }, [string]>(
        "SELECT id,after_id FROM replication_comment_order WHERE id IN (SELECT value FROM json_each(?))",
      )
      .all(JSON.stringify(commentEffects.map((effect) => effect.comment.id)))
      .map((entry) => [entry.id, entry.after_id]),
  );
  const comments = commentEffects.map((effect) => ({
    taskId: effect.taskId,
    comment: effect.comment,
    after: after.get(effect.comment.id) ?? null,
  }));
  const transition: ReplicationTransition = {
    command: step.operation,
    actor,
    timestamp: step.timestamp,
    targets: step.targets,
    entities,
    components,
    addresses,
    comments,
    receipts: [],
    readContext: transitionReads(step, metadata),
    predicates: portablePredicates(step, metadata),
  };
  connection
    .query("INSERT INTO replication_transition_queue(sequence,json) VALUES(?,?)")
    .run(step.index, JSON.stringify(transition));
  const head = connection.query(
    "INSERT INTO replication_transition_heads VALUES(?,?,?) ON CONFLICT(entity_id) DO UPDATE SET version=excluded.version,parents_json=excluded.parents_json",
  );
  for (const entry of entities) {
    if (entry.after !== null) {
      head.run(entry.id, entry.after.version, JSON.stringify(entry.after.parents ?? []));
    }
  }
}
