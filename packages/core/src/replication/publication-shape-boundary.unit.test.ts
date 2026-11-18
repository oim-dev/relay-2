import { describe, expect, test } from "bun:test";
import {
  assertReplicationChangesetShape,
  assertReplicationPublicationShape,
  type PortableProjectSnapshot,
  type ReplicationChangeset,
  type ReplicationTransition,
} from "@relay/contracts";
import { portableEntity, replicationFingerprint } from "@relay/storage";
import { assertPublicationSource } from "./publication-source";
import { validatePublicationEnvelope } from "./publication-envelope";

/**
 * Создаёт source одной команды с валидными версиями и parents без SQLite и повторного writer.
 */
function createSource(): ReplicationChangeset {
  const before = portableEntity({
    id: "document",
    kind: "document",
    key: "DOC-1",
    createdAt: "2026-11-17T00:00:00.000Z",
    updatedAt: "2026-11-17T00:00:00.000Z",
    createdBy: "Автор",
    updatedBy: "Автор",
    data: {
      name: "Документ",
      summary: "",
      body: "До",
      documentKind: "description",
      documentStatus: "draft",
      sectionId: null,
      pinned: false,
    },
  });
  const after = portableEntity(
    { ...before.record, data: { ...before.record.data, body: "После" } },
    [before.version],
  );
  const transition: ReplicationTransition = {
    command: "document.update",
    actor: "Автор",
    timestamp: after.record.updatedAt,
    targets: { primaryId: "document", ownerIds: ["document"], roles: { ref: "document" } },
    entities: [{ id: "document", before, after }],
    components: [],
    addresses: [],
    comments: [],
    receipts: [],
    readContext: [],
    predicates: [],
  };
  const source = {
    formatVersion: 1 as const,
    modelVersion: 2 as const,
    projectId: "project",
    mode: "mutation" as const,
    id: "replica:1",
    replicaId: "replica",
    sequence: 1,
    createdAt: after.record.updatedAt,
    dependencies: [],
    readContext: [],
    entities: transition.entities,
    components: [],
    transitions: [transition],
    addresses: [],
    comments: [],
    receipts: [],
  };
  return { ...source, digest: replicationFingerprint(source) };
}

/**
 * Пересчитывает внешний digest после намеренной подмены, чтобы проверить более глубокую гарантию Core.
 */
function redigest(source: ReplicationChangeset): ReplicationChangeset {
  const { digest: _digest, ...payload } = source;
  return { ...payload, digest: replicationFingerprint(payload) };
}

describe("Core после общей проверки формы репликации", () => {
  test("допустимая boundary проходит без изменения исходного payload", () => {
    const source = createSource();
    const before = structuredClone(source);

    assertPublicationSource(source);

    expect(source).toEqual(before);
  });

  test("неизвестное поле source отказывает на общей shape-границе даже с пересчитанным digest", () => {
    const corrupted = redigest({ ...createSource(), ...{ unexpected: true } });

    expect(() => assertPublicationSource(corrupted)).toThrow(
      expect.objectContaining({ code: "REPLICATION_FORMAT", details: { path: "unexpected" } }),
    );
  });

  test("синтаксически правильный digest не заменяет проверку содержимого source", () => {
    const corrupted = { ...createSource(), digest: "0".repeat(64) };
    assertReplicationChangesetShape(corrupted);

    expect(() => assertPublicationSource(corrupted)).toThrow(
      expect.objectContaining({ code: "REPLICATION_ACK_MISMATCH" }),
    );
  });

  test("после shape Core по-прежнему сверяет версии первичных сторон", () => {
    const source = createSource();
    const entities = source.entities.map((entry) => ({
      ...entry,
      after: entry.after === null ? null : { ...entry.after, version: "0".repeat(64) },
    }));
    const corrupted = redigest({ ...source, entities });
    assertReplicationChangesetShape(corrupted);

    expect(() => assertPublicationSource(corrupted)).toThrow(
      expect.objectContaining({ code: "REPLICATION_FORMAT", details: { path: "record.version" } }),
    );
  });

  test("shape не разрешает model 2 без доказанной command tape", () => {
    const { transitions: _transitions, ...withoutTape } = createSource();
    const corrupted = redigest(withoutTape);
    assertReplicationChangesetShape(corrupted);

    expect(() => assertPublicationSource(corrupted)).toThrow(
      expect.objectContaining({ code: "REPLICATION_TRANSITION_REQUIRED" }),
    );
  });

  test("канонический список parents с лишним предком остаётся нарушением причинности Core", () => {
    const source = createSource();
    const original = source.entities[0];
    const transition = source.transitions?.[0];
    if (original?.before == null || original.after === null || transition === undefined) {
      throw new Error("Fixture должен содержать изменение существующей записи");
    }
    const after = portableEntity(original.after.record, [original.before.version, "f".repeat(64)]);
    const entities = [{ ...original, after }];
    const corrupted = redigest({
      ...source,
      entities,
      transitions: [{ ...transition, entities }],
    });
    assertReplicationChangesetShape(corrupted);

    expect(() => assertPublicationSource(corrupted)).toThrow(
      expect.objectContaining({
        code: "REPLICATION_FORMAT",
        details: { path: "source.entity.parents" },
      }),
    );
  });

  test("строковая форма targets не подменяет предметные роли именованной команды", () => {
    const source = createSource();
    const transitions = source.transitions;
    if (transitions === undefined) {
      throw new Error("Fixture должен содержать исходную command tape");
    }
    const corrupted = redigest({
      ...source,
      transitions: transitions.map((step) => ({
        ...step,
        targets: { primaryId: "document", ownerIds: [], roles: {} },
      })),
    });
    assertReplicationChangesetShape(corrupted);

    expect(() => assertPublicationSource(corrupted)).toThrow(
      expect.objectContaining({
        code: "REPLICATION_FORMAT",
        details: { path: "transition.targets" },
      }),
    );
  });

  test("пустая лента publication имеет форму, но не становится подтверждением Core", () => {
    const snapshot: PortableProjectSnapshot = {
      formatVersion: 1,
      modelVersion: 2,
      projectId: "project",
      entities: [],
      components: [],
      addresses: [],
      comments: [],
      receipts: [],
      confirmations: [],
      publication: {
        formatVersion: 1,
        publicationId: "a".repeat(64),
        snapshotDigest: "b".repeat(64),
        parent: null,
        accepted: [],
        changes: [],
      },
    };
    assertReplicationPublicationShape(snapshot.publication);

    expect(() => validatePublicationEnvelope(snapshot)).toThrow(
      expect.objectContaining({ code: "REPLICATION_PUBLICATION_REQUIRED" }),
    );
  });
});
