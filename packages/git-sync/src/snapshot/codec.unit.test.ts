import { describe, expect, test } from "bun:test";
import { createCodecSnapshot, readCodecRow } from "./codec.unit-fixture";
import { decodeSnapshotData, encodeSnapshot } from "./files";

describe("Табличное переносимое дерево проекта", () => {
  test("документ экспортируется одной типизированной SQL-строкой без wrapper и локального CAS", () => {
    const files = encodeSnapshot(createCodecSnapshot());

    const [path, document] = readCodecRow(files, "documents");

    expect(path).toMatch(/^documents\/[a-f0-9]{64}\.json$/);
    expect(document).toMatchObject({
      id: "document",
      name: "Документ",
      name_json: null,
      summary: null,
      summary_json: '"unpaired:\\ud800"',
      body: "\ufeff# Начало\r\n\tТекст  \r\n",
      body_json: null,
      document_kind: "description",
      document_status: "draft",
      section_id: null,
      pinned: 0,
    });
    for (const field of ["record", "data", "value", "markdown", "revision"]) {
      expect(document).not.toHaveProperty(field);
    }
    expect([...files.keys()].some((name) => /^(entities|components)\//.test(name))).toBe(false);
    expect(
      [...files.keys()].every(
        (name) => name === "manifest.json" || /^[a-z][a-z0-9_]*\/[a-f0-9]{64}\.json$/.test(name),
      ),
    ).toBe(true);
  });

  test("каждый JSON содержит читаемую строку и ровно один конечный LF", () => {
    const files = encodeSnapshot(createCodecSnapshot());

    for (const bytes of files.values()) {
      const json = Buffer.from(bytes).toString("utf8");
      expect(json.startsWith('{\n  "')).toBe(true);
      expect(json.endsWith("\n")).toBe(true);
      expect(json.endsWith("\n\n")).toBe(false);
    }
  });

  test("порядок владельцев, адресов и полей не меняет bytes или порядок Git-файлов", () => {
    const snapshot = createCodecSnapshot();
    const reordered = {
      ...snapshot,
      entities: [...snapshot.entities].reverse().map((entity) => ({
        ...entity,
        record: {
          ...entity.record,
          data: Object.fromEntries(Object.entries(entity.record.data).reverse()),
        },
      })),
      addresses: [...snapshot.addresses].reverse(),
    };

    const original = encodeSnapshot(snapshot);
    const reorderedFiles = encodeSnapshot(reordered);

    expect([...reorderedFiles.keys()]).toEqual([...original.keys()]);
    expect(reorderedFiles).toEqual(original);
    expect(decodeSnapshotData(new Map([...original].reverse()))).toEqual(
      decodeSnapshotData(original),
    );
  });

  test("кодирование и чтение сохраняют исходную проекцию и карту файлов вызывающего", () => {
    const snapshot = createCodecSnapshot();
    const original = structuredClone(snapshot);

    const files = encodeSnapshot(snapshot);
    const originalFiles = new Map([...files].map(([path, bytes]) => [path, Buffer.from(bytes)]));
    decodeSnapshotData(files);

    expect(snapshot).toEqual(original);
    expect([...files]).toEqual([...originalFiles]);
  });

  test("writer проверяет runtime версию логической проекции", () => {
    const snapshot = createCodecSnapshot();
    Reflect.set(snapshot, "formatVersion", 2);

    expect(() => encodeSnapshot(snapshot)).toThrow(
      expect.objectContaining({ code: "GIT_FORMAT_INCOMPATIBLE" }),
    );
  });

  test.each([1, 2])("reader отказывает layout %s до чтения прежних файлов", (layoutVersion) => {
    const files = new Map([
      [
        "manifest.json",
        Buffer.from(
          JSON.stringify({
            layoutVersion,
            formatVersion: 1,
            modelVersion: 2,
            projectId: "project",
          }),
        ),
      ],
    ]);

    expect(() => decodeSnapshotData(files)).toThrow(
      expect.objectContaining({ code: "GIT_FORMAT_INCOMPATIBLE" }),
    );
  });

  test("снимок обязан принадлежать ожидаемому projectId", () => {
    const files = encodeSnapshot(createCodecSnapshot());

    expect(() => decodeSnapshotData(files, "another")).toThrow(
      expect.objectContaining({ code: "GIT_PROJECT_MISMATCH" }),
    );
  });

  test("manifest обязан совпадать с projectId предметной строки", () => {
    const files = encodeSnapshot(createCodecSnapshot());
    files.set(
      "manifest.json",
      Buffer.from('{"layoutVersion":3,"formatVersion":1,"modelVersion":2,"projectId":"another"}'),
    );

    expect(() => decodeSnapshotData(files)).toThrow(
      expect.objectContaining({ code: "GIT_INVALID_SNAPSHOT" }),
    );
  });

  test("отсутствующий manifest не превращается в пустой проект", () => {
    const files = encodeSnapshot(createCodecSnapshot());
    files.delete("manifest.json");

    expect(() => decodeSnapshotData(files)).toThrow(
      expect.objectContaining({ code: "GIT_INVALID_SNAPSHOT" }),
    );
  });

  test("имя строки сверяется с фактическим PK после чтения JSON", () => {
    const files = encodeSnapshot(createCodecSnapshot());
    const [path, row] = readCodecRow(files, "documents");
    files.set(path, Buffer.from(JSON.stringify({ ...row, id: "other-document" })));

    expect(() => decodeSnapshotData(files)).toThrow(
      expect.objectContaining({ code: "GIT_INVALID_SNAPSHOT" }),
    );
  });

  test("копия строки под другим именем не создаёт вторую версию одного PK", () => {
    const files = encodeSnapshot(createCodecSnapshot());
    const [, row] = readCodecRow(files, "documents");
    files.set(`documents/${"f".repeat(64)}.json`, Buffer.from(JSON.stringify(row)));

    expect(() => decodeSnapshotData(files)).toThrow(
      expect.objectContaining({ code: "GIT_INVALID_SNAPSHOT" }),
    );
  });

  test("writer отказывает дубликату постоянного ID вместо последней победившей строки", () => {
    const snapshot = createCodecSnapshot();
    const duplicate = snapshot.entities.find((entity) => entity.record.id === "document");
    if (!duplicate) {
      throw new Error("В fixture отсутствует документ");
    }

    expect(() =>
      encodeSnapshot({ ...snapshot, entities: [...snapshot.entities, duplicate] }),
    ).toThrow(expect.objectContaining({ code: "GIT_INVALID_SNAPSHOT" }));
  });

  test.each([
    { name: "неизвестное поле", field: "unexpected", value: "не терять молча" },
    { name: "локальный CAS", field: "revision", value: 42 },
  ])("$name строки отвергается проверкой Storage", ({ field, value }) => {
    const files = encodeSnapshot(createCodecSnapshot());
    const [path, row] = readCodecRow(files, "documents");
    files.set(path, Buffer.from(JSON.stringify({ ...row, [field]: value })));

    expect(() => decodeSnapshotData(files)).toThrow(
      expect.objectContaining({ code: "GIT_INVALID_SNAPSHOT" }),
    );
  });

  test.each([
    { name: "неизвестный корневой файл", path: "unknown.json" },
    { name: "неизвестная таблица", path: `unknown_table/${"a".repeat(64)}.json` },
    { name: "локальная таблица CAS", path: `local_entity_revisions/${"a".repeat(64)}.json` },
    { name: "вложенный record.json", path: `documents/${"a".repeat(64)}/record.json` },
  ])("$name отклоняет всё дерево", ({ path }) => {
    const files = encodeSnapshot(createCodecSnapshot());
    files.set(path, Buffer.from("{}"));

    expect(() => decodeSnapshotData(files)).toThrow(
      expect.objectContaining({ code: "GIT_INVALID_SNAPSHOT" }),
    );
  });

  test("одинаковый ID критерия у разных задач даёт разные строки составного PK", () => {
    const snapshot = createCodecSnapshot();
    const task = snapshot.entities.find((entity) => entity.record.id === "task");
    const criterion = snapshot.components?.find((component) => component.kind === "task-criterion");
    const address = snapshot.components?.find(
      (component) => component.kind === "address-assignment" && component.ownerId === "task",
    );
    if (!task || !criterion || !address || address.kind !== "address-assignment") {
      throw new Error("В fixture отсутствует задача с критерием");
    }
    const value = {
      ...snapshot,
      entities: [
        ...snapshot.entities,
        { ...task, record: { ...task.record, id: "task-b", key: "task-b" } },
      ],
      addresses: [...snapshot.addresses, { ref: "task-b", entityId: "task-b" }],
      components: [
        ...(snapshot.components ?? []),
        {
          ...address,
          ownerId: "task-b",
          id: "address-task-b",
          value: { ref: "task-b" },
        },
        { ...criterion, ownerId: "task-b", deleted: true },
      ],
    };

    const files = encodeSnapshot(value);
    const restored = decodeSnapshotData(files);

    expect([...files.keys()].filter((path) => path.startsWith("task_criteria/"))).toHaveLength(2);
    expect(restored).toMatchObject({ components: value.components });
  });

  test("одинаковый составной PK запрещён даже для разных состояний снятия", () => {
    const snapshot = createCodecSnapshot();
    const criterion = snapshot.components?.find((component) => component.kind === "task-criterion");
    if (!criterion) {
      throw new Error("В fixture отсутствует критерий");
    }

    expect(() =>
      encodeSnapshot({
        ...snapshot,
        components: [...(snapshot.components ?? []), { ...criterion, deleted: true }],
      }),
    ).toThrow(expect.objectContaining({ code: "GIT_INVALID_SNAPSHOT" }));
  });

  test("технические строки сохраняют исходный source, proofs и точные исторические receipts", () => {
    const snapshot = createCodecSnapshot();
    const receipt = {
      operationKey: "CON:/операция/" + "x".repeat(512),
      requestJson: '{ "actor": "Автор", "body": "до\\r\\n" }',
      resultJson: '{ "revision": 41, "key": "старый-ключ", "body": "после\\udfff" }',
    };
    const source = {
      formatVersion: 1 as const,
      modelVersion: 2 as const,
      projectId: "project",
      digest: "c".repeat(64),
      mode: "mutation" as const,
      id: "replica:1",
      replicaId: "replica",
      sequence: 1,
      createdAt: "2026-01-01T00:00:00.000Z",
      dependencies: [],
      readContext: [],
      entities: snapshot.entities.map((after) => ({ id: after.record.id, before: null, after })),
      components: [],
      transitions: [],
      addresses: [],
      comments: [],
      receipts: [receipt],
    };
    const publication = {
      formatVersion: 1 as const,
      publicationId: "d".repeat(64),
      parent: null,
      snapshotDigest: "e".repeat(64),
      accepted: [
        {
          changesetId: source.id,
          sourceDigest: source.digest,
          resolutionId: null,
          effectDigest: "f".repeat(64),
        },
      ],
      changes: [{ source, resolution: null, transitions: [] }],
    };
    const confirmations = [
      {
        replicaId: "replica",
        ranges: [[1, 1] as const],
        proofs: [
          {
            sequence: 1,
            digest: source.digest,
            publicationId: publication.publicationId,
            resolutionId: null,
            effectDigest: "f".repeat(64),
            outcome: "applied" as const,
          },
        ],
      },
    ];

    const files = encodeSnapshot({ ...snapshot, receipts: [receipt], confirmations, publication });
    const restored = decodeSnapshotData(files);

    expect(restored).toMatchObject({ receipts: [receipt], confirmations, publication });
    expect([...files.keys()].filter((path) => !path.includes("/"))).toEqual(["manifest.json"]);
  });
});
