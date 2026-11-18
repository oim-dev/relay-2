import type {
  PortableEntity,
  PortableReplicationResolution,
  ReplicationChangeset,
  ReplicationConflict,
  ReplicationPublication,
  ReplicationTransition,
} from "./replication.types";

/**
 * Создаёт свежую карточку только для формы: фиксированный digest намеренно не доказывает её содержание.
 */
function shapeEntity(): PortableEntity {
  return {
    record: {
      id: "document",
      kind: "document",
      key: "DOC-1",
      createdAt: "2026-11-17T00:00:00.000Z",
      updatedAt: "2026-11-17T00:00:00.000Z",
      createdBy: "Автор",
      updatedBy: "Автор",
      data: { body: "BOM:\ufeff\r\nНепарный:\ud800" },
    },
    version: "a".repeat(64),
    parents: [],
  };
}

/**
 * Создаёт свежую boundary с владельцем, частью и causal guard; бизнес-валидность здесь не утверждается.
 */
export function createShapeTransition(): ReplicationTransition {
  const entity = shapeEntity();
  return {
    command: "document.update",
    actor: "Автор",
    timestamp: "2026-11-17T00:00:00.000Z",
    targets: { primaryId: "document", ownerIds: ["document"], roles: { ref: "document" } },
    entities: [{ id: "document", before: entity, after: entity }],
    components: [
      {
        key: '["document","collection","relations"]',
        before: null,
        after: {
          ownerId: "document",
          id: "relations",
          kind: "collection",
          position: "V",
          version: "b".repeat(64),
          parents: [],
          deleted: false,
          value: { field: "relations" },
        },
      },
    ],
    addresses: [{ ref: "DOC-1", entityId: "document" }],
    comments: [],
    receipts: [],
    readContext: [
      { id: "document", kind: "content", version: entity.version, sourceChangesetId: null },
    ],
    predicates: [{ selector: { kind: "entity", ref: "document" }, records: [], present: null }],
  };
}

/**
 * Создаёт полный source для shape-проверок без SQL, пересчёта хешей и причинного основания.
 */
export function createShapeChangeset(): ReplicationChangeset {
  const step = createShapeTransition();
  return {
    formatVersion: 1,
    modelVersion: 2,
    projectId: "project",
    digest: "c".repeat(64),
    mode: "mutation",
    id: "replica:1",
    replicaId: "replica",
    sequence: 1,
    createdAt: "2026-11-17T00:00:00.000Z",
    dependencies: [],
    readContext: step.readContext,
    entities: step.entities,
    components: step.components,
    transitions: [step],
    addresses: step.addresses,
    comments: [],
    receipts: [
      {
        operationKey: "operation",
        requestJson: '{ "body": "\\ud800" }\r\n',
        resultJson: '{ "revision": 42, "key": "DOC-1" }\n',
      },
    ],
  };
}

/**
 * Создаёт проверяемую JSON-форму решения выбранного варианта; scope/digest намеренно не подтверждены.
 */
export function createShapeResolution(
  choice: "local" | "remote" | "custom" | "keys",
): PortableReplicationResolution {
  const source = createShapeChangeset();
  const material: ReplicationConflict = {
    id: source.id,
    fingerprint: "d".repeat(64),
    code: "REPLICATION_CONFLICT",
    message: "Просмотренный конфликт",
    changeset: source,
    local: [shapeEntity()],
    remote: [shapeEntity()],
    localComponents: [],
    remoteComponents: [],
    localComments: [],
    remoteComments: [],
    remoteReceipts: source.receipts,
    remoteAddresses: source.addresses,
  };
  const common = {
    formatVersion: 1 as const,
    resolutionId: "e".repeat(64),
    changesetId: source.id,
    sourceDigest: source.digest,
    actor: "Автор решения",
    createdAt: "2026-11-17T00:00:00.000Z",
    remoteDigest: "f".repeat(64),
    fingerprint: material.fingerprint,
    material,
  };
  if (choice === "keys") {
    return { ...common, choice, assignments: [{ entityId: "document", key: "DOC-9" }] };
  }
  if (choice === "custom") {
    return {
      ...common,
      choice,
      patch: [{ transition: 0, entityId: "document", field: "body", value: "Точный:\udfff\r\n" }],
    };
  }
  return { ...common, choice };
}

/**
 * Создаёт свежую публикацию с исходными строками receipt и явно недоказанными фиксированными хешами.
 */
export function createShapePublication(): ReplicationPublication {
  const source = createShapeChangeset();
  return {
    formatVersion: 1,
    publicationId: "1".repeat(64),
    snapshotDigest: "2".repeat(64),
    parent: null,
    accepted: [
      {
        changesetId: source.id,
        sourceDigest: source.digest,
        resolutionId: null,
        effectDigest: "3".repeat(64),
      },
    ],
    changes: [{ source, resolution: null, transitions: source.transitions ?? [] }],
  };
}
