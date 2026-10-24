import {
  componentIdentity,
  type PortableEntity,
  type PortableProjectSnapshot,
  type ReplicationChangeset,
  type ReplicationTransition,
} from "@relay/contracts";
import { portableEntity, replicationFingerprint } from "@relay/storage";
import { confirmChangeset } from "../../../src/replication/confirmations";
import { publishChanges } from "../../../src/replication/publication";
import { effectivePredicates } from "../../../src/replication/publication-predicates";
import { logicalRecord } from "../../../src/replication/snapshot-records";

/**
 * Строит намеренно непроверенную публикацию с правильными hashes/proofs для negative boundary tests.
 * Предметный переход не выполняется: тест обязан доказать, что consumer отвергает его независимо от hashes.
 */
export function unverifiedPublication(
  parent: PortableProjectSnapshot,
  before: PortableEntity,
  after: PortableEntity,
  operation: string,
  sequence = 1,
): PortableProjectSnapshot {
  const transition: ReplicationTransition = {
    command: operation,
    actor: after.record.updatedBy,
    timestamp: after.record.updatedAt,
    targets: {
      primaryId: after.record.id,
      ownerIds: [after.record.id],
      roles: { ref: after.record.id },
    },
    entities: [{ id: before.record.id, before, after }],
    components: [],
    addresses: [],
    comments: [],
    receipts: [],
    readContext: [
      { id: before.record.id, kind: "content", version: before.version, sourceChangesetId: null },
    ],
    predicates: [
      {
        selector: { kind: "entity", ref: before.record.id },
        records: [{ id: before.record.id, version: before.version }],
        present: null,
      },
    ],
  };
  const payload: Omit<ReplicationChangeset, "digest"> = {
    formatVersion: 1,
    modelVersion: 2,
    projectId: parent.projectId,
    mode: "mutation",
    id: `untrusted-publisher:${sequence}`,
    replicaId: "untrusted-publisher",
    sequence,
    createdAt: after.record.updatedAt,
    dependencies: [],
    readContext: transition.readContext,
    entities: transition.entities,
    components: [],
    addresses: [],
    comments: [],
    receipts: [],
    transitions: [transition],
  };
  const source = { ...payload, digest: replicationFingerprint(payload) };
  const candidate = {
    ...parent,
    entities: parent.entities.map((entry) => (entry.record.id === after.record.id ? after : entry)),
    confirmations: confirmChangeset(
      parent.confirmations,
      source.replicaId,
      source.sequence,
      source.digest,
    ),
  };
  return publishChanges(parent, candidate, [
    { source, resolution: null, transitions: [transition] },
  ]);
}

/**
 * Строит недоверенную публикацию прямой подстановкой source effects, без merge и validators.
 * Это только упаковка adversarial fixture с согласованными hashes, не oracle допустимости перехода.
 * Тест задаёт исходный source и проверяет публичный отказ consumer, включая атомарность SQLite.
 */
export function unverifiedSourcePublication(
  parent: PortableProjectSnapshot,
  source: ReplicationChangeset,
): PortableProjectSnapshot {
  let snapshot = parent;
  const transitions: ReplicationTransition[] = [];
  for (const step of source.transitions ?? []) {
    const entities = new Map(snapshot.entities.map((entry) => [entry.record.id, entry]));
    const components = new Map(
      (snapshot.components ?? []).map((entry) => [componentIdentity(entry), entry]),
    );
    const addresses = new Map(snapshot.addresses.map((entry) => [entry.ref, entry.entityId]));
    for (const change of step.entities) {
      if (change.after !== null) {
        entities.set(change.id, change.after);
      }
    }
    for (const part of step.components) {
      components.set(part.key, part.after);
    }
    for (const address of step.addresses) {
      addresses.set(address.ref, address.entityId);
    }
    transitions.push({
      ...step,
      entities: step.entities.filter((entry) => entry.before?.version !== entry.after?.version),
      components: step.components.filter((entry) => entry.before?.version !== entry.after.version),
      predicates: effectivePredicates(snapshot, step.predicates),
      readContext: step.readContext.map((entry) => {
        const record = snapshot.entities.find((candidate) => candidate.record.id === entry.id);
        return {
          ...entry,
          version: entry.kind === "existence" ? null : (record?.version ?? null),
          ...(entry.logicalDigest === undefined || record === undefined
            ? {}
            : {
                logicalDigest: replicationFingerprint(
                  portableEntity(logicalRecord(record, snapshot)).record,
                ),
              }),
        };
      }),
    });
    snapshot = {
      ...snapshot,
      entities: [...entities.values()],
      components: [...components.values()],
      addresses: [...addresses].map(([ref, entityId]) => ({ ref, entityId })),
      comments: [...snapshot.comments, ...step.comments],
      receipts: [...snapshot.receipts, ...step.receipts],
    };
  }
  const receipts = source.receipts.filter(
    (entry) => !snapshot.receipts.some((saved) => saved.operationKey === entry.operationKey),
  );
  if (receipts.length > 0) {
    transitions.push({
      command: "receipt",
      actor:
        source.entities.find((entry) => entry.after !== null)?.after?.record.updatedBy ??
        "relay:migration",
      entities: [],
      components: [],
      addresses: [],
      comments: [],
      readContext: [],
      predicates: [],
      receipts,
    });
    snapshot = { ...snapshot, receipts: [...snapshot.receipts, ...receipts] };
  }
  return publishChanges(
    parent,
    {
      ...snapshot,
      confirmations: confirmChangeset(
        parent.confirmations,
        source.replicaId,
        source.sequence,
        source.digest,
      ),
    },
    [{ source, resolution: null, transitions }],
  );
}

/**
 * Пересчитывает только внешний digest после намеренного изменения source в negative fixture.
 */
export function redigestSource(source: ReplicationChangeset): ReplicationChangeset {
  const { digest: _digest, ...payload } = source;
  return { ...payload, digest: replicationFingerprint(payload) };
}
