import { describe, expect, test } from "bun:test";
import type { PortableProjectSnapshot } from "@relay/contracts";
import { decodeSnapshotData as decodeSnapshot, encodeSnapshot } from "./files";
import { object } from "./json";

const snapshot: PortableProjectSnapshot = {
  formatVersion: 1,
  modelVersion: 2,
  components: [],
  publication: null,
  projectId: "project",
  entities: [
    {
      version: "a".repeat(64),
      record: {
        id: "CON:<id>/../🙂",
        kind: "document",
        key: "old-key",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        createdBy: "Автор",
        updatedBy: "Автор",
        data: {
          body: "\ufeff# Начало\r\n\tТекст  \r\n",
          name: "Документ",
          description: "unpaired:\ud800",
        },
      },
    },
  ],
  addresses: [],
  confirmations: [
    {
      replicaId: "replica",
      ranges: [
        [1, 3],
        [5, 5],
      ],
    },
  ],
  comments: [
    {
      taskId: "task",
      after: null,
      comment: {
        id: "comment",
        title: "",
        body: "\udfff",
        createdAt: "2026-01-01T00:00:00.000Z",
        createdBy: "Автор",
      },
    },
  ],
  receipts: [],
};

describe("Переносимое дерево текущего снимка", () => {
  test("writer выпускает layout 2 с точными pretty JSON bytes и одним LF", () => {
    const files = encodeSnapshot(snapshot);

    expect(Buffer.from(files.get("manifest.json") ?? []).toString()).toBe(
      '{\n  "formatVersion": 1,\n  "layoutVersion": 2,\n  "modelVersion": 2,\n  "projectId": "project"\n}\n',
    );
    expect(Buffer.from(files.get("publication.json") ?? []).toString()).toBe("null\n");
    for (const [path, bytes] of files) {
      if (path.endsWith(".json")) {
        const json = Buffer.from(bytes).toString();
        expect(json.endsWith("\n")).toBe(true);
        expect(json.endsWith("\n\n")).toBe(false);
      }
    }
  });

  test.each([
    { name: "будущий layout", versions: { layoutVersion: 3, formatVersion: 1, modelVersion: 2 } },
    {
      name: "строковый layout",
      versions: { layoutVersion: "2", formatVersion: 1, modelVersion: 2 },
    },
    { name: "будущий format", versions: { layoutVersion: 2, formatVersion: 2, modelVersion: 2 } },
    { name: "прежняя model", versions: { layoutVersion: 1, formatVersion: 1, modelVersion: 1 } },
  ])("$name отвергается как несовместимый", ({ versions }) => {
    const files = encodeSnapshot(snapshot);
    files.set("manifest.json", Buffer.from(JSON.stringify({ ...versions, projectId: "project" })));

    expect(() => decodeSnapshot(files)).toThrow(
      expect.objectContaining({ code: "GIT_FORMAT_INCOMPATIBLE" }),
    );
  });

  test("writer проверяет runtime formatVersion, даже если caller нарушил TypeScript контракт", () => {
    const invalid = structuredClone(snapshot);
    Reflect.set(invalid, "formatVersion", 2);

    expect(() => encodeSnapshot(invalid)).toThrow(
      expect.objectContaining({ code: "GIT_FORMAT_INCOMPATIBLE" }),
    );
  });

  test("ID внутри записи обязан совпадать с SHA-256 путём", () => {
    const files = encodeSnapshot(snapshot);
    const path = [...files.keys()].find(
      (path) => path.startsWith("entities/") && path.endsWith("record.json"),
    );
    if (!path) {
      throw new Error("В fixture отсутствует карточка");
    }
    const wrapper = object(JSON.parse(Buffer.from(files.get(path) ?? []).toString()));
    const entity = object(wrapper.entity);
    object(entity.record).id = "другая идентичность";
    files.set(path, Buffer.from(JSON.stringify(wrapper)));

    expect(() => decodeSnapshot(files)).toThrow(
      expect.objectContaining({ code: "GIT_INVALID_SNAPSHOT" }),
    );
  });

  test("manifest остаётся закрытой схемой и требует projectId", () => {
    const files = encodeSnapshot(snapshot);
    files.set(
      "manifest.json",
      Buffer.from(
        '{"layoutVersion":2,"formatVersion":1,"modelVersion":2,"projectId":"project","sqlVersion":1}',
      ),
    );

    expect(() => decodeSnapshot(files)).toThrow(
      expect.objectContaining({ code: "GIT_INVALID_SNAPSHOT" }),
    );
    files.set(
      "manifest.json",
      Buffer.from('{"layoutVersion":2,"formatVersion":1,"modelVersion":2}'),
    );
    expect(() => decodeSnapshot(files)).toThrow(
      expect.objectContaining({ code: "GIT_INVALID_SNAPSHOT" }),
    );
  });

  test("model 2 сохраняет scoped components и не выносит local CAS в raw owner", () => {
    const components: NonNullable<PortableProjectSnapshot["components"]> = [
      {
        ownerId: "task-a",
        kind: "task-criterion",
        id: "same-id",
        position: "a0",
        version: "b".repeat(64),
        parents: [],
        deleted: false,
        value: {
          id: "same-id",
          title: "Критерий A",
          summary: "",
          description: "\ufeffОписание\r\n",
          completed: false,
          completedAt: null,
          completedBy: null,
        },
      },
      {
        ownerId: "task-b",
        kind: "task-criterion",
        id: "same-id",
        position: "a0",
        version: "c".repeat(64),
        parents: [],
        deleted: true,
        value: {
          id: "same-id",
          title: "Критерий B",
          summary: "",
          description: "\ud800",
          completed: false,
          completedAt: null,
          completedBy: null,
        },
      },
    ];
    const value = { ...snapshot, components };

    const files = encodeSnapshot(value);
    const decoded = decodeSnapshot(files);

    expect(decoded).toMatchObject({ components: expect.arrayContaining(components) });
    expect(
      [...files.keys()].filter(
        (path) => path.startsWith("components/") && path.endsWith("record.json"),
      ),
    ).toHaveLength(2);
    const owner = [...files].find(
      ([path]) => path.startsWith("entities/") && path.endsWith("record.json"),
    );
    expect(JSON.parse(Buffer.from(owner?.[1] ?? []).toString()).entity.record).not.toHaveProperty(
      "revision",
    );
  });

  test("publication source и исторические revision проходят layout без реконструкции payload", () => {
    const files = encodeSnapshot(snapshot);
    const publication = {
      formatVersion: 1,
      changes: [
        {
          source: {
            formatVersion: 1,
            digest: "opaque-original",
            entities: [
              {
                before: { record: { revision: 41, data: { body: "до\r\n" } } },
                after: { record: { revision: 42, data: { body: "после\udfff" } } },
              },
            ],
            receipts: [{ resultJson: '{"revision":41,"key":"старый-ключ"}' }],
          },
        },
      ],
    };
    files.set("publication.json", Buffer.from(JSON.stringify(publication)));

    const decoded = decodeSnapshot(files);

    expect(decoded).toMatchObject({ publication });
  });

  test("сохраняет CRLF, табуляцию, конечный newline и непарные surrogate без потери", () => {
    const files = encodeSnapshot(snapshot);

    const restored = decodeSnapshot(files, "project");

    expect(restored).toEqual(snapshot);
    const markdown = [...files].find(([path]) => path.endsWith("body.md"));
    expect(Buffer.from(markdown?.[1] ?? []).toString("utf8")).toBe(
      "\ufeff# Начало\r\n\tТекст  \r\n",
    );
    expect(
      [...files.keys()].every((path) =>
        path.split("/").every((part) => part.length <= 80 && !part.includes(":")),
      ),
    ).toBe(true);
  });

  test("неизвестный путь отклоняет всё дерево вместо игнорирования данных", () => {
    const files = encodeSnapshot(snapshot);
    files.set("unknown.json", Buffer.from("{}"));

    expect(() => decodeSnapshot(files)).toThrow(
      expect.objectContaining({ code: "GIT_INVALID_SNAPSHOT" }),
    );
  });

  test("несовместимый manifest и чужой project ID имеют отдельные стабильные ошибки", () => {
    const files = encodeSnapshot(snapshot);

    expect(() => decodeSnapshot(files, "another")).toThrow(
      expect.objectContaining({ code: "GIT_PROJECT_MISMATCH" }),
    );
    files.set("manifest.json", Buffer.from('{"formatVersion":2,"projectId":"project"}'));
    expect(() => decodeSnapshot(files)).toThrow(
      expect.objectContaining({ code: "GIT_FORMAT_INCOMPATIBLE" }),
    );
  });

  test("порядок ключей объектов не меняет Git bytes, Markdown не нормализуется", () => {
    const files = encodeSnapshot(snapshot);
    const reordered = {
      ...snapshot,
      entities: snapshot.entities.map((item) => ({
        ...item,
        record: {
          ...item.record,
          data: {
            description: "unpaired:\ud800",
            name: "Документ",
            body: "\ufeff# Начало\r\n\tТекст  \r\n",
          },
        },
      })),
    };

    expect(encodeSnapshot(reordered)).toEqual(files);
  });
});
