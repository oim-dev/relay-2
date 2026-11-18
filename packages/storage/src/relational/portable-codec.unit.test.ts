import { describe, expect, test } from "bun:test";
import type { PortableProjectSnapshot } from "@relay/contracts";
import { portableRowsToSnapshot, snapshotToPortableRows } from "./portable-codec";
import {
  codecBody,
  codecIds,
  codecReceipt,
  codecTime,
  createComposedPortableFixture,
  createPortableCodecFixture,
} from "./portable-codec.unit-fixture";

/**
 * Требует код повреждённой формы, исключая случайный TypeError либо ошибку fixture.
 */
function expectCorrupt(action: () => unknown): void {
  expect(action).toThrow(expect.objectContaining({ code: "CORRUPT_DATA" }));
}

/**
 * Убирает одну физическую колонку из внешнего ввода, не меняя корректную typed строку.
 */
function withoutColumn(value: object, column: string): unknown {
  return Object.fromEntries(Object.entries(value).filter(([name]) => name !== column));
}

describe("Физический переносимый codec", () => {
  test("документ имеет самостоятельные скаляры и единственный точный UTF-16 carrier", () => {
    const snapshot = createPortableCodecFixture();

    const rows = snapshotToPortableRows(snapshot);

    expect(rows.tables.documents).toEqual([
      {
        id: codecIds.document,
        created_at: codecTime,
        updated_at: codecTime,
        created_by: "Автор",
        updated_by: "Автор",
        project_id: codecIds.project,
        name: "Документ",
        name_json: null,
        summary: null,
        summary_json: '"Непарный:\\ud800"',
        body: "\ufeff# Точный текст\r\n\tСтрока  \r\nnul:\0\n",
        body_json: null,
        document_kind: "specification",
        document_status: "active",
        section_id: null,
        pinned: 1,
      },
    ]);
    expect(Object.keys(rows).sort()).toEqual(["projectId", "tables"]);
    expect(Object.hasOwn(rows.tables, "local_entity_revisions")).toBe(false);
    expect(Object.hasOwn(rows.tables, "local_comment_sequences")).toBe(false);
    expect(
      rows.tables.replication_entity_versions.find((row) => row.entity_id === codecIds.document),
    ).toEqual({ entity_id: codecIds.document, version: "e".repeat(64), parents_json: "[]" });
  });

  test("цель задачи хранит конкретный FK фичи и сохраняет ID назначения", () => {
    const snapshot = createPortableCodecFixture();

    const rows = snapshotToPortableRows(snapshot);

    expect(rows.tables.task_targets).toEqual([
      {
        owner_id: codecIds.task,
        id: "target-assignment",
        position: "V",
        version: "b".repeat(64),
        parents_json: `["${"a".repeat(64)}"]`,
        deleted: 0,
        feature_id: codecIds.feature,
        scenario_id: null,
        implementation_id: null,
      },
    ]);
  });

  test("журнал использует тот же text carrier и переносимый after вместо local sequence", () => {
    const snapshot = createPortableCodecFixture();

    const rows = snapshotToPortableRows(snapshot);

    expect(rows.tables.task_comments).toEqual([
      {
        id: "comment-1",
        task_id: codecIds.task,
        title: null,
        title_json: '"Точный:\\ud800"',
        body: codecBody,
        body_json: null,
        created_at: codecTime,
        created_by: "Автор",
        after_id: null,
      },
    ]);
  });

  test("полный состав и история проходят JSON roundtrip с точными scoped ID, снятиями и receipts", () => {
    const snapshot = createComposedPortableFixture();
    const original = structuredClone(snapshot);

    const rows = snapshotToPortableRows(snapshot);
    const external: unknown = JSON.parse(JSON.stringify(rows));
    const restored = portableRowsToSnapshot(external);

    expect(restored).toEqual(original);
    expect(snapshot).toEqual(original);
    expect(rows.tables.task_criteria.map((row) => [row.owner_id, row.id, row.deleted])).toEqual([
      [codecIds.task, "criterion-1", 0],
      [codecIds.dependency, "criterion-1", 1],
    ]);
    expect(rows.tables.batch_receipts).toEqual([
      {
        operation_key: "original-operation",
        request_json: '{ "actor": "Автор", "commands": [ ] }\r\n',
        result_json:
          '{"operationKey":"original-operation","revision":73,"key":"OLD-7","text":"\\ud800"}\n',
      },
    ]);
    expect(restored.publication?.changes[0]?.source.receipts).toEqual([codecReceipt]);
    expect(restored.publication?.changes[0]?.source.entities[0]?.after?.record).toMatchObject({
      key: "ORIGINAL-7",
      data: { name: "Первоначальное название", body: "Первоначальная версия:\ud800\r\n" },
    });
    expect(restored.publication).toEqual(original.publication);
  });

  test("порядок свойств publication и proofs не меняет байты технических JSON и исходные строки receipts", () => {
    const snapshot = createComposedPortableFixture();
    const publication = snapshot.publication;
    if (publication === null || publication === undefined) {
      throw new Error("Fixture должен содержать source публикации");
    }
    const reordered: PortableProjectSnapshot = {
      ...snapshot,
      publication: {
        changes: publication.changes.map((change) => ({
          transitions: change.transitions,
          resolution: change.resolution,
          source: {
            ...change.source,
            receipts: change.source.receipts.map((receipt) => ({
              resultJson: receipt.resultJson,
              requestJson: receipt.requestJson,
              operationKey: receipt.operationKey,
            })),
          },
        })),
        accepted: publication.accepted.map((entry) => ({
          effectDigest: entry.effectDigest,
          resolutionId: entry.resolutionId,
          sourceDigest: entry.sourceDigest,
          changesetId: entry.changesetId,
        })),
        snapshotDigest: publication.snapshotDigest,
        parent:
          publication.parent === null
            ? null
            : {
                snapshotDigest: publication.parent.snapshotDigest,
                publicationId: publication.parent.publicationId,
              },
        publicationId: publication.publicationId,
        formatVersion: publication.formatVersion,
      },
      confirmations: snapshot.confirmations.map((entry) => {
        if (entry.proofs === undefined) {
          return entry;
        }
        return {
          ...entry,
          proofs: entry.proofs.map(({ sequence, digest, ...bindings }) => ({
            ...bindings,
            digest,
            sequence,
          })),
        };
      }),
    };
    expect(JSON.stringify(reordered.publication)).not.toBe(JSON.stringify(publication));

    const originalRows = snapshotToPortableRows(snapshot);
    const reorderedRows = snapshotToPortableRows(reordered);
    const restored = portableRowsToSnapshot(reorderedRows);

    expect(reorderedRows.tables.replication_publications).toEqual(
      originalRows.tables.replication_publications,
    );
    expect(reorderedRows.tables.replication_confirmations).toEqual(
      originalRows.tables.replication_confirmations,
    );
    expect(reorderedRows.tables.replication_confirmations[0]?.proofs_json).toBe(
      `[{"digest":"${"c".repeat(64)}","effectDigest":"${"d".repeat(64)}","outcome":"applied","publicationId":"${"f".repeat(64)}","resolutionId":null,"sequence":1}]`,
    );
    expect(restored).toEqual(snapshot);
    expect(restored.publication?.changes[0]?.source.receipts).toEqual([codecReceipt]);
    expect(reorderedRows.tables.batch_receipts).toEqual([
      {
        operation_key: "original-operation",
        request_json: '{ "actor": "Автор", "commands": [ ] }\r\n',
        result_json:
          '{"operationKey":"original-operation","revision":73,"key":"OLD-7","text":"\\ud800"}\n',
      },
    ]);
  });

  test("исторические labels и порядок ссылок восстанавливаются из position после перестановки строк", () => {
    const snapshot = createComposedPortableFixture();
    const rows = snapshotToPortableRows(snapshot);
    const reversed = {
      ...rows,
      tables: {
        ...rows.tables,
        checkpoint_references: [...rows.tables.checkpoint_references].reverse(),
        checkpoint_acceptances: [...rows.tables.checkpoint_acceptances].reverse(),
      },
    };

    const restored = portableRowsToSnapshot(reversed);

    expect(
      restored.entities.find(({ record }) => record.id === codecIds.intent)?.record.data.references,
    ).toEqual([
      { id: codecIds.feature, kind: "feature", key: "OLD-FEATURE", title: "Историческое:\udc00" },
    ]);
    expect(
      restored.entities.find(({ record }) => record.id === codecIds.result)?.record.data.references,
    ).toEqual([
      { id: codecIds.task, kind: "task", key: "OLD-TASK", title: "Прежняя задача" },
      { id: codecIds.document, kind: "document", key: "OLD-DOC", title: "Прежний документ" },
    ]);
    expect(
      restored.entities.find(({ record }) => record.id === codecIds.result)?.record.data
        .acceptedSessionIds,
    ).toEqual([codecIds.child]);
  });

  test("доска, участие и текущий run выводятся из единственных первичных связей", () => {
    const snapshot = createComposedPortableFixture();

    const rows = snapshotToPortableRows(snapshot);
    const restored = portableRowsToSnapshot(rows);

    expect(rows.tables.applications[0]).not.toHaveProperty("board_id");
    expect(rows.tables.applications[0]).not.toHaveProperty("prefix");
    expect(rows.tables.implementations[0]).toMatchObject({
      feature_id: null,
      scenario_id: codecIds.scenario,
    });
    expect(rows.tables.implementations[0]).not.toHaveProperty("active");
    expect(rows.tables.work_sessions[0]).not.toHaveProperty("current_run_id");
    expect(
      restored.entities.find(({ record }) => record.id === codecIds.application)?.record.data,
    ).toMatchObject({ boardId: codecIds.appBoard, prefix: "APP" });
    expect(
      restored.entities.find(({ record }) => record.id === codecIds.implementation)?.record.data,
    ).toMatchObject({
      active: true,
      featureId: codecIds.feature,
      targetKind: "scenario",
      scenarioId: codecIds.scenario,
    });
    expect(
      restored.entities.find(({ record }) => record.id === codecIds.session)?.record.data
        .currentRunId,
    ).toBe("run-2");
  });

  test("feature-реализация не получает отсутствовавший scenarioId", () => {
    const snapshot = createComposedPortableFixture();
    const changed: PortableProjectSnapshot = {
      ...snapshot,
      entities: snapshot.entities.map((entity) =>
        entity.record.kind !== "implementation"
          ? entity
          : {
              ...entity,
              record: {
                ...entity.record,
                data: {
                  title: "Реализация",
                  description: "",
                  status: "partial",
                  applicationId: codecIds.application,
                  featureId: codecIds.feature,
                  targetKind: "feature",
                  targetId: codecIds.feature,
                  active: true,
                },
              },
            },
      ),
    };

    const restored = portableRowsToSnapshot(snapshotToPortableRows(changed));

    expect(restored).toEqual(changed);
    expect(
      restored.entities.find(({ record }) => record.kind === "implementation")?.record.data,
    ).not.toHaveProperty("scenarioId");
  });

  test("отсутствующие parents владельца канонизируются в обязательный JSON-массив", () => {
    const snapshot = createPortableCodecFixture();
    const changed: PortableProjectSnapshot = {
      ...snapshot,
      entities: snapshot.entities.map(({ record, version }) => ({ record, version })),
    };

    const rows = snapshotToPortableRows(changed);
    const restored = portableRowsToSnapshot(rows);

    expect(rows.tables.replication_entity_versions.map((row) => row.parents_json)).toEqual([
      "[]",
      "[]",
      "[]",
      "[]",
      "[]",
      "[]",
    ]);
    expect(restored).toEqual(snapshot);
    expect(changed.entities.every((entity) => !Object.hasOwn(entity, "parents"))).toBe(true);
  });

  test.each([null, "null"])(
    "недопустимый parents_json %j отвергается вместо SQL NULL",
    (parents) => {
      const rows = snapshotToPortableRows(createPortableCodecFixture());
      const corrupted = {
        ...rows,
        tables: {
          ...rows.tables,
          replication_entity_versions: rows.tables.replication_entity_versions.map((row) => ({
            ...row,
            parents_json: parents,
          })),
        },
      };

      expectCorrupt(() => portableRowsToSnapshot(corrupted));
    },
  );

  test("канонизация parents верхнего уровня сохраняет отсутствующее поле original publication source", () => {
    const snapshot = createComposedPortableFixture();
    if (snapshot.publication === null || snapshot.publication === undefined) {
      throw new Error("Fixture должен содержать source публикации");
    }
    const changed: PortableProjectSnapshot = {
      ...snapshot,
      entities: snapshot.entities.map(({ record, version }) => ({ record, version })),
      publication: {
        ...snapshot.publication,
        changes: snapshot.publication.changes.map((change) => ({
          ...change,
          source: {
            ...change.source,
            entities: change.source.entities.map((effect) => ({
              ...effect,
              after:
                effect.after === null
                  ? null
                  : {
                      record: effect.after.record,
                      version: effect.after.version,
                    },
            })),
          },
        })),
      },
    };

    const restored = portableRowsToSnapshot(snapshotToPortableRows(changed));

    expect(restored.entities).toEqual(snapshot.entities);
    expect(restored.publication).toEqual(changed.publication);
    expect(restored.publication?.changes[0]?.source.entities[0]?.after).not.toHaveProperty(
      "parents",
    );
    expect(restored.receipts).toEqual(changed.receipts);
    expect(restored.confirmations).toEqual(changed.confirmations);
  });

  test("optional proofs отличаются от пустого массива, null publication даёт пустую таблицу", () => {
    const snapshot = createPortableCodecFixture();
    const changed: PortableProjectSnapshot = {
      ...snapshot,
      confirmations: [
        { replicaId: "a", ranges: [] },
        { replicaId: "b", ranges: [], proofs: [] },
      ],
    };

    const rows = snapshotToPortableRows(changed);
    const restored = portableRowsToSnapshot(rows);

    expect(rows.tables.replication_publications).toEqual([]);
    expect(rows.tables.replication_confirmations).toEqual([
      { replica_id: "a", ranges_json: "[]", proofs_json: null },
      { replica_id: "b", ranges_json: "[]", proofs_json: "[]" },
    ]);
    expect(restored).toEqual(changed);
  });

  test("повторный PK владельца отклоняется до построения снимка", () => {
    const rows = snapshotToPortableRows(createPortableCodecFixture());
    const corrupted = {
      ...rows,
      tables: { ...rows.tables, documents: [...rows.tables.documents, ...rows.tables.documents] },
    };

    expectCorrupt(() => portableRowsToSnapshot(corrupted));
  });

  test("повторный составной PK части отклоняется, разные владельцы со scoped ID допустимы", () => {
    const rows = snapshotToPortableRows(createComposedPortableFixture());
    const corrupted = {
      ...rows,
      tables: {
        ...rows.tables,
        task_criteria: [...rows.tables.task_criteria, ...rows.tables.task_criteria],
      },
    };

    expectCorrupt(() => portableRowsToSnapshot(corrupted));
  });

  test("несовпадение вида физической строки и object_ids отклоняется", () => {
    const rows = snapshotToPortableRows(createPortableCodecFixture());
    const corrupted = {
      ...rows,
      tables: {
        ...rows.tables,
        object_ids: rows.tables.object_ids.map((row) =>
          row.id === codecIds.document ? { ...row, kind: "feature" } : row,
        ),
      },
    };

    expectCorrupt(() => portableRowsToSnapshot(corrupted));
  });

  test("подмена PK publication при неизменённом payload отвергается", () => {
    const rows = snapshotToPortableRows(createComposedPortableFixture());
    const corrupted = {
      ...rows,
      tables: {
        ...rows.tables,
        replication_publications: rows.tables.replication_publications.map((row) => ({
          ...row,
          id: "0".repeat(64),
        })),
      },
    };

    expectCorrupt(() => portableRowsToSnapshot(corrupted));
  });

  test.each(["revision", "unknown_column", "__proto__"])(
    "неизвестная колонка %s не теряется молча",
    (column) => {
      const rows = snapshotToPortableRows(createPortableCodecFixture());
      const corrupted = {
        ...rows,
        tables: {
          ...rows.tables,
          documents: rows.tables.documents.map((row) => ({ ...row, [column]: 42 })),
        },
      };

      expectCorrupt(() => portableRowsToSnapshot(corrupted));
    },
  );

  test.each(["body", "body_json", "project_id"])(
    "обязательная физическая колонка %s должна присутствовать",
    (column) => {
      const rows = snapshotToPortableRows(createPortableCodecFixture());
      const corrupted = {
        ...rows,
        tables: {
          ...rows.tables,
          documents: rows.tables.documents.map((row) => withoutColumn(row, column)),
        },
      };

      expectCorrupt(() => portableRowsToSnapshot(corrupted));
    },
  );

  test.each(["unknown_table", "local_entity_revisions", "local_comment_sequences"])(
    "непереносимая таблица %s отклоняется",
    (table) => {
      const rows = snapshotToPortableRows(createPortableCodecFixture());

      expectCorrupt(() =>
        portableRowsToSnapshot({ ...rows, tables: { ...rows.tables, [table]: [] } }),
      );
    },
  );

  test("отсутствующая переносимая таблица не подменяется пустым набором", () => {
    const rows = snapshotToPortableRows(createPortableCodecFixture());

    expectCorrupt(() =>
      portableRowsToSnapshot({ ...rows, tables: withoutColumn(rows.tables, "products") }),
    );
  });

  test("XOR цели отвергает два одновременно заполненных typed FK", () => {
    const rows = snapshotToPortableRows(createComposedPortableFixture());
    const corrupted = {
      ...rows,
      tables: {
        ...rows.tables,
        task_targets: rows.tables.task_targets.map((row) => ({
          ...row,
          scenario_id: codecIds.scenario,
        })),
      },
    };

    expectCorrupt(() => portableRowsToSnapshot(corrupted));
  });

  test("фича в колонке FK сценария отвергается даже при существующем UUID", () => {
    const rows = snapshotToPortableRows(createPortableCodecFixture());
    const corrupted = {
      ...rows,
      tables: {
        ...rows.tables,
        task_targets: rows.tables.task_targets.map((row) => ({
          ...row,
          feature_id: null,
          scenario_id: codecIds.feature,
        })),
      },
    };

    expectCorrupt(() => portableRowsToSnapshot(corrupted));
  });

  test("двойной carrier не выбирает произвольную копию текста", () => {
    const rows = snapshotToPortableRows(createPortableCodecFixture());
    const corrupted = {
      ...rows,
      tables: {
        ...rows.tables,
        documents: rows.tables.documents.map((row) => ({ ...row, summary: "Другая копия" })),
      },
    };

    expectCorrupt(() => portableRowsToSnapshot(corrupted));
  });

  test("испорченный JSON родителей возвращает CORRUPT_DATA", () => {
    const rows = snapshotToPortableRows(createPortableCodecFixture());
    const corrupted = {
      ...rows,
      tables: {
        ...rows.tables,
        task_targets: rows.tables.task_targets.map((row) => ({ ...row, parents_json: "[" })),
      },
    };

    expectCorrupt(() => portableRowsToSnapshot(corrupted));
  });

  test.each([
    { table: "replication_publications", column: "payload_json" },
    { table: "replication_confirmations", column: "ranges_json" },
    { table: "replication_confirmations", column: "proofs_json" },
    { table: "batch_receipts", column: "request_json" },
    { table: "batch_receipts", column: "result_json" },
  ] as const)("испорченный JSON $table.$column возвращает CORRUPT_DATA", ({ table, column }) => {
    const rows = snapshotToPortableRows(createComposedPortableFixture());
    const corrupted = {
      ...rows,
      tables: {
        ...rows.tables,
        [table]: rows.tables[table].map((row) => ({ ...row, [column]: "{" })),
      },
    };

    expectCorrupt(() => portableRowsToSnapshot(corrupted));
  });

  test("publication проверяет вложенную форму source, а не только верхний envelope", () => {
    const snapshot = createComposedPortableFixture();
    const publication = snapshot.publication;
    const originalChange = publication?.changes[0];
    if (publication === undefined || publication === null || originalChange === undefined) {
      throw new Error("Fixture должен содержать source публикации");
    }
    const rows = snapshotToPortableRows(snapshot);
    const corrupted = {
      ...rows,
      tables: {
        ...rows.tables,
        replication_publications: [
          {
            id: publication.publicationId,
            payload_json: JSON.stringify({
              ...publication,
              changes: [
                {
                  ...originalChange,
                  source: { ...originalChange.source, dependencies: [42] },
                },
              ],
            }),
          },
        ],
      },
    };

    expectCorrupt(() => portableRowsToSnapshot(corrupted));
  });

  test("чужой run с тем же scoped ID не закрывает отсутствующий FK checkpoint", () => {
    const rows = snapshotToPortableRows(createComposedPortableFixture());
    const corrupted = {
      ...rows,
      tables: {
        ...rows.tables,
        session_runs: rows.tables.session_runs.filter(
          (row) => row.owner_id !== codecIds.session || row.id !== "run-1",
        ),
      },
    };

    expectCorrupt(() => portableRowsToSnapshot(corrupted));
  });

  test("повторная position исторических ссылок не приводит к неоднозначному порядку", () => {
    const rows = snapshotToPortableRows(createComposedPortableFixture());
    const corrupted = {
      ...rows,
      tables: {
        ...rows.tables,
        checkpoint_references: rows.tables.checkpoint_references.map((row) => ({
          ...row,
          position: 0,
        })),
      },
    };

    expectCorrupt(() => portableRowsToSnapshot(corrupted));
  });

  test("рассогласованное производное поле active отвергается при экспорте", () => {
    const snapshot = createComposedPortableFixture();
    const corrupted = {
      ...snapshot,
      entities: snapshot.entities.map((entity) =>
        entity.record.kind === "implementation"
          ? {
              ...entity,
              record: { ...entity.record, data: { ...entity.record.data, active: false } },
            }
          : entity,
      ),
    };

    expectCorrupt(() => snapshotToPortableRows(corrupted));
  });

  test("featureId реализации сценария должен совпадать с первичной связью scenarios", () => {
    const snapshot = createComposedPortableFixture();
    const corrupted = {
      ...snapshot,
      entities: snapshot.entities.map((entity) =>
        entity.record.kind === "implementation"
          ? {
              ...entity,
              record: {
                ...entity.record,
                data: { ...entity.record.data, featureId: codecIds.task },
              },
            }
          : entity,
      ),
    };

    expectCorrupt(() => snapshotToPortableRows(corrupted));
  });

  test("несогласованные адреса snapshot не заменяются незаметно назначениями компонентов", () => {
    const snapshot = createPortableCodecFixture();

    expectCorrupt(() => snapshotToPortableRows({ ...snapshot, addresses: [] }));
  });

  test("отсутствующая publication прежнего envelope не трактуется как null", () => {
    const snapshot = createPortableCodecFixture();
    const { publication, ...legacy } = snapshot;
    expect(publication).toBeNull();

    expectCorrupt(() => snapshotToPortableRows(legacy));
  });
});
