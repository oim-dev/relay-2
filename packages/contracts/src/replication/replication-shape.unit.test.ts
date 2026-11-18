import { describe, expect, test } from "bun:test";
import { assertReplicationPublicationShape } from "./replication-publication-shape";
import { assertPortableReplicationResolutionShape } from "./replication-resolution-shape";
import {
  assertReplicationChangesetShape,
  assertReplicationTransitionShape,
} from "./replication-source-shape";
import type { ReplicationPredicate, ReplicationPublication } from "./replication.types";
import {
  createShapeChangeset,
  createShapePublication,
  createShapeResolution,
  createShapeTransition,
} from "./replication-shape.unit-fixture";

const selectors = [
  { kind: "entity", ref: "document", entityKind: "document", semantic: "content" },
  { kind: "identities", refs: ["document"] },
  { kind: "records", ids: ["document"], entityKind: "document" },
  { kind: "virtual", ref: "product", entityKind: "board" },
  { kind: "field", entityKind: "task", field: "boardId", value: "board" },
  { kind: "field-set", entityKind: "task", field: "boardId", values: ["board"] },
  { kind: "kind", entityKind: "document" },
  {
    kind: "array-item",
    entityKind: "task",
    arrayField: "targets",
    itemField: "id",
    value: "feature",
  },
  { kind: "task-graph" },
  { kind: "memberships", taskId: "task" },
  { kind: "address-state", ref: "DOC-1" },
  { kind: "receipt", operationKey: "operation" },
] as const satisfies readonly ReplicationPredicate["selector"][];

const invalidSelectors = [
  { name: "неизвестный вид", selector: { kind: "sql", query: "SELECT 1" } },
  {
    name: "локальный allocator",
    selector: { kind: "key", entityKind: "task", prefix: "TASK", after: 0, excluded: [] },
  },
  { name: "неверный entityKind", selector: { kind: "kind", entityKind: "unknown" } },
  { name: "постороннее поле", selector: { kind: "task-graph", ref: "task" } },
  { name: "нестроковый элемент", selector: { kind: "records", ids: [42] } },
  { name: "неверная semantic", selector: { kind: "entity", ref: "task", semantic: "write" } },
];

/**
 * Убирает поле из внешнего JSON, сохраняя исходную typed fixture неизменной.
 */
function withoutField(value: object, field: string): unknown {
  return Object.fromEntries(Object.entries(value).filter(([name]) => name !== field));
}

/**
 * Фиксирует именно отказ переносимой формы, не случайный TypeError или ошибку ожидания.
 */
function expectFormat(action: () => unknown): void {
  expect(action).toThrow(expect.objectContaining({ code: "REPLICATION_FORMAT" }));
}

describe("Общая форма репликационного протокола", () => {
  test("publication проверяется без пересоздания source, receipt, текстов и порядка массивов", () => {
    const publication = createShapePublication();
    const original = structuredClone(publication);
    const value: unknown = publication;

    assertReplicationPublicationShape(value);
    const typed: ReplicationPublication = value;

    expect(typed).toBe(publication);
    expect(typed).toEqual(original);
    expect(typed.changes[0]?.source.receipts[0]?.resultJson).toBe(
      '{ "revision": 42, "key": "DOC-1" }\n',
    );
    expect(typed.changes[0]?.source.entities[0]?.after?.record.data.body).toBe(
      "BOM:\ufeff\r\nНепарный:\ud800",
    );
  });

  test.each(["local", "remote", "custom", "keys"] as const)(
    "решение %s сохраняет вариант и его просмотренные стороны",
    (choice) => {
      const original = createShapeResolution(choice);
      const value: unknown = structuredClone(original);

      assertPortableReplicationResolutionShape(value);

      expect(value.choice).toBe(choice);
      expect(value).toEqual(original);
    },
  );

  test("синтаксически корректные хеши и недоказанный scope не объявляются предметно проверенными", () => {
    const source = createShapeChangeset();
    const resolution = createShapeResolution("keys");
    const semanticConflict = {
      ...resolution,
      assignments: [{ entityId: "outside-source", key: "DOC-1" }],
    };

    expect(() => assertReplicationChangesetShape(source)).not.toThrow();
    expect(() => assertPortableReplicationResolutionShape(semanticConflict)).not.toThrow();
  });

  test.each(selectors)("переносимый selector $kind принимается", (selector) => {
    const transition = {
      ...createShapeTransition(),
      predicates: [{ selector, records: [{ id: "owner", version: null }], present: null }],
    };

    expect(() => assertReplicationTransitionShape(transition)).not.toThrow();
  });

  test.each(invalidSelectors)("$name selector отвергается", ({ selector }) => {
    const corrupted = {
      ...createShapeTransition(),
      predicates: [{ selector, records: [], present: null }],
    };

    expectFormat(() => assertReplicationTransitionShape(corrupted));
  });

  test.each(["source", "resolution", "transitions"])(
    "обязательное поле change.%s не подставляется",
    (field) => {
      const publication = createShapePublication();
      const change = publication.changes[0];
      if (change === undefined) {
        throw new Error("Нет change в fixture");
      }

      expectFormat(() =>
        assertReplicationPublicationShape({
          ...publication,
          changes: [withoutField(change, field)],
        }),
      );
    },
  );

  test("лишнее поле вложенного source отвергается до использования typed payload", () => {
    const publication = createShapePublication();
    const corrupted = {
      ...publication,
      changes: publication.changes.map((change) => ({
        ...change,
        source: { ...change.source, unknown: true },
      })),
    };

    expectFormat(() => assertReplicationPublicationShape(corrupted));
  });

  test("неверная вложенная часть не превращается в PortableComponent утверждением типа", () => {
    const source = createShapeChangeset();
    const corrupted = {
      ...source,
      components: [{ key: "part", before: null, after: { id: "part", value: {} } }],
    };

    expectFormat(() => assertReplicationChangesetShape(corrupted));
  });

  test("повреждение readContext и guard версии отвергается внутри source", () => {
    const source = createShapeChangeset();
    const corrupted = {
      ...source,
      readContext: [{ id: "document", kind: "content", version: 42, sourceChangesetId: null }],
    };

    expectFormat(() => assertReplicationChangesetShape(corrupted));
  });

  test("legacy source допускает историческую revision, модель 2 её не принимает", () => {
    const source = createShapeChangeset();
    const {
      modelVersion: _modelVersion,
      components: _components,
      transitions: _transitions,
      ...legacy
    } = source;
    const entities = source.entities.map((change) => ({
      ...change,
      after:
        change.after === null
          ? null
          : { ...change.after, record: { ...change.after.record, revision: 42 } },
    }));

    expect(() => assertReplicationChangesetShape({ ...legacy, entities })).not.toThrow();
    expectFormat(() => assertReplicationChangesetShape({ ...source, entities }));
  });

  test("keys не расширяет старый серверный pendingResolution", () => {
    const resolution = createShapeResolution("remote");
    const corrupted = {
      ...resolution,
      material: { ...resolution.material, pendingResolution: createShapeResolution("keys") },
    };

    expectFormat(() => assertPortableReplicationResolutionShape(corrupted));
  });

  test("fromKey различает назначения одного UUID без изменения их порядка и строк", () => {
    const resolution = createShapeResolution("keys");
    const assignments = [
      { entityId: "document", fromKey: "DOC-1", key: "DOC-9" },
      { entityId: "document", fromKey: "DOC-2", key: "DOC-10" },
    ];
    const value: unknown = { ...resolution, assignments };

    assertPortableReplicationResolutionShape(value);

    if (value.choice !== "keys") {
      throw new Error("Ожидалось ключевое решение");
    }
    expect(value.assignments).toBe(assignments);
    expect(value.assignments).toEqual([
      { entityId: "document", fromKey: "DOC-1", key: "DOC-9" },
      { entityId: "document", fromKey: "DOC-2", key: "DOC-10" },
    ]);
  });

  test("нестроковый fromKey отклоняется общей формой", () => {
    const resolution = createShapeResolution("keys");
    const corrupted = {
      ...resolution,
      assignments: [{ entityId: "document", fromKey: 42, key: "DOC-9" }],
    };

    expectFormat(() => assertPortableReplicationResolutionShape(corrupted));
  });

  test("старое pendingResolution local сохраняется в позднем решении remote", () => {
    const resolution = createShapeResolution("remote");
    const value = {
      ...resolution,
      material: {
        ...resolution.material,
        pendingResolution: createShapeResolution("local"),
        acceptedResolutionId: null,
      },
    };

    expect(() => assertPortableReplicationResolutionShape(value)).not.toThrow();
  });

  test("цикл pendingResolution отклоняется предметным кодом формы вместо переполнения стека", () => {
    const resolution = createShapeResolution("remote");
    Reflect.set(resolution.material, "pendingResolution", resolution);

    expectFormat(() => assertPortableReplicationResolutionShape(resolution));
  });

  test("пропуск элемента sparse-массива не принимается за пустую форму", () => {
    const publication = createShapePublication();
    const corrupted = { ...publication, changes: new Array(1) };

    expectFormat(() => assertReplicationPublicationShape(corrupted));
  });
});
