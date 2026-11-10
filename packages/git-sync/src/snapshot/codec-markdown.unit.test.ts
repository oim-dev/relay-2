import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import type { PortableProjectSnapshot } from "@relay/contracts";
import { decodeSnapshotData, encodeSnapshot } from "./files";
import { object } from "./json";
import { encodeLayoutOneFixture } from "../../tests/integration/helpers/layout-1-fixture";

const texts = [
  {
    name: "пустой blob",
    body: "",
    digest: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  },
  {
    name: "без конечного LF",
    body: "abc",
    digest: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  },
  {
    name: "BOM, CRLF, tabs и пробелы",
    body: "\ufeff# Текст\r\n\tСтрока  \r\n",
    digest: "a89cb0bc69bd6d81de2f67727b5aeb51b42a501e5111268aa8dbab39d3f6c637",
  },
  {
    name: "декомпозированный Unicode и surrogate pair",
    body: "e\u0301🙂",
    digest: "0dec8e71703372a904beafcead77edc7b268cac65d12f7b3e716b435bfcce389",
  },
];
const digest = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
const invalidDescriptors = [
  { name: "прежнее имя без digest", markdown: ["body"] },
  { name: "нет digest", markdown: [{ field: "body" }] },
  { name: "нет field", markdown: [{ digest }] },
  { name: "лишнее поле", markdown: [{ field: "body", digest, encoding: "utf8" }] },
  {
    name: "дубликат поля",
    markdown: [
      { field: "body", digest },
      { field: "body", digest },
    ],
  },
  { name: "путь вместо поля", markdown: [{ field: "../body", digest }] },
  { name: "неизвестное поле", markdown: [{ field: "name", digest }] },
  { name: "uppercase digest", markdown: [{ field: "body", digest: digest.toUpperCase() }] },
  { name: "неверный digest", markdown: [{ field: "body", digest: "0".repeat(64) }] },
  { name: "blob без дескриптора", markdown: [] },
];

/**
 * Минимальные raw owners проверяют только физический codec, без предметной публикации Core.
 */
function snapshot(body: string): PortableProjectSnapshot {
  return {
    formatVersion: 1,
    modelVersion: 2,
    projectId: "project",
    publication: null,
    addresses: [],
    receipts: [],
    confirmations: [],
    entities: [
      {
        version: "a".repeat(64),
        record: {
          id: "entity",
          kind: "document",
          key: "doc-1",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
          createdBy: "Автор",
          updatedBy: "Автор",
          data: { name: "Документ", body },
        },
      },
    ],
    components: [
      {
        ownerId: "task",
        kind: "task-criterion",
        id: "part",
        position: "a0",
        version: "b".repeat(64),
        parents: [],
        deleted: false,
        value: {
          id: "part",
          title: "Критерий",
          description: body,
          summary: body,
          completed: false,
          completedAt: null,
          completedBy: null,
        },
      },
    ],
    comments: [
      {
        taskId: "task",
        after: null,
        comment: {
          id: "comment",
          title: "",
          body,
          createdAt: "2026-01-01T00:00:00.000Z",
          createdBy: "Автор",
        },
      },
    ],
  };
}

/**
 * Возвращает единственный raw wrapper выбранного владельца; отсутствие — ошибка fixture.
 */
function recordFile(
  files: Map<string, Uint8Array>,
  owner: string,
): [string, Record<string, unknown>] {
  const entry = [...files].find(
    ([path]) => path.startsWith(owner + "/") && path.endsWith("/record.json"),
  );
  if (!entry) {
    throw new Error("В fixture отсутствует raw owner");
  }
  return [entry[0], object(JSON.parse(Buffer.from(entry[1]).toString("utf8")))];
}

describe("Дескрипторы точных Markdown blobs", () => {
  test.each(texts)(
    "$name сохраняет bytes и SHA-256 владельца, компонента и комментария",
    ({ body, digest }) => {
      const value = snapshot(body);
      const files = encodeSnapshot(value);

      expect(decodeSnapshotData(files)).toEqual(value);
      for (const [owner, field] of [
        ["entities", "body"],
        ["components", "description"],
        ["comments", "body"],
      ] as const) {
        const [path, wrapper] = recordFile(files, owner);
        expect(wrapper.markdown).toEqual(
          owner === "components"
            ? [
                { field, digest },
                { field: "summary", digest },
              ]
            : [{ field, digest }],
        );
        expect(files.get(path.replace("record.json", field + ".md"))).toEqual(Buffer.from(body));
      }
    },
  );

  test("непарные surrogate остаются JSON escape без дескрипторов и без replacement blobs", () => {
    const value = snapshot("до\ud800/\udfffпосле");
    const files = encodeSnapshot(value);

    expect(decodeSnapshotData(files)).toEqual(value);
    expect([...files.keys()].some((path) => path.endsWith(".md"))).toBe(false);
    for (const owner of ["entities", "components", "comments"]) {
      const [path, wrapper] = recordFile(files, owner);
      expect(wrapper.markdown).toEqual([]);
      expect(Buffer.from(files.get(path) ?? []).toString()).toContain("до\\ud800/\\udfffпосле");
    }
  });

  test.each(invalidDescriptors)("$name отклоняется до Core", ({ markdown }) => {
    const files = encodeSnapshot(snapshot("abc"));
    const [path, wrapper] = recordFile(files, "entities");
    files.set(path, Buffer.from(JSON.stringify({ ...wrapper, markdown })));

    expect(() => decodeSnapshotData(files)).toThrow(
      expect.objectContaining({ code: "GIT_INVALID_SNAPSHOT" }),
    );
  });

  test.each(["entities", "components", "comments"])(
    "%s: повреждённый raw blob не проходит с прежним digest",
    (owner) => {
      const files = encodeSnapshot(snapshot("abc"));
      const [path] = recordFile(files, owner);
      const field = owner === "components" ? "description" : "body";
      files.set(path.replace("record.json", field + ".md"), Buffer.from("abc\n"));

      expect(() => decodeSnapshotData(files)).toThrow(
        expect.objectContaining({ code: "GIT_INVALID_SNAPSHOT" }),
      );
    },
  );

  test("совпадающий digest не разрешает повреждённый UTF-8", () => {
    const files = encodeSnapshot(snapshot("abc"));
    const [path, wrapper] = recordFile(files, "comments");
    const invalidUtf8 = Uint8Array.from([0xed, 0xa0, 0x80]);
    files.set(path.replace("record.json", "body.md"), invalidUtf8);
    files.set(
      path,
      Buffer.from(
        JSON.stringify({
          ...wrapper,
          markdown: [
            { field: "body", digest: createHash("sha256").update(invalidUtf8).digest("hex") },
          ],
        }),
      ),
    );

    expect(() => decodeSnapshotData(files)).toThrow(
      expect.objectContaining({ code: "GIT_INVALID_SNAPSHOT" }),
    );
  });

  test.each(["entities", "components", "comments"])(
    "%s: missing blob и missing markdown не превращаются в пустой текст",
    (owner) => {
      const files = encodeSnapshot(snapshot(""));
      const [path, wrapper] = recordFile(files, owner);
      const field = owner === "components" ? "description" : "body";
      files.delete(path.replace("record.json", field + ".md"));

      expect(() => decodeSnapshotData(files)).toThrow(
        expect.objectContaining({ code: "GIT_INVALID_SNAPSHOT" }),
      );
      delete wrapper.markdown;
      files.set(path, Buffer.from(JSON.stringify(wrapper)));
      expect(() => decodeSnapshotData(files)).toThrow(
        expect.objectContaining({ code: "GIT_INVALID_SNAPSHOT" }),
      );
    },
  );

  test.each(["entities", "components", "comments"])(
    "%s: layout 2 не принимает well-formed inline текст даже без blob",
    (owner) => {
      const files = encodeSnapshot(snapshot("\ud800"));
      const [path] = recordFile(files, owner);
      const inline = Buffer.from(files.get(path) ?? [])
        .toString()
        .replace("\\ud800", "abc");
      files.set(path, Buffer.from(inline));

      expect(() => decodeSnapshotData(files)).toThrow(
        expect.objectContaining({ code: "GIT_INVALID_SNAPSHOT" }),
      );
    },
  );

  test.each(["entities", "components", "comments"])(
    "%s: wrapper остаётся закрытым при корректных дескрипторах",
    (owner) => {
      const files = encodeSnapshot(snapshot("abc"));
      const [path, wrapper] = recordFile(files, owner);
      files.set(path, Buffer.from(JSON.stringify({ ...wrapper, futureEncoding: true })));

      expect(() => decodeSnapshotData(files)).toThrow(
        expect.objectContaining({ code: "GIT_INVALID_SNAPSHOT" }),
      );
    },
  );

  test("metadata компонента не пропускает неизвестное поле до Core", () => {
    const files = encodeSnapshot(snapshot("abc"));
    const [path, wrapper] = recordFile(files, "components");
    object(wrapper.component).revision = 1;
    files.set(path, Buffer.from(JSON.stringify(wrapper)));

    expect(() => decodeSnapshotData(files)).toThrow(
      expect.objectContaining({ code: "GIT_INVALID_SNAPSHOT" }),
    );
  });

  test("подмена manifest на layout 1 не легализует новые wrappers или лишние blobs", () => {
    const files = encodeSnapshot(snapshot("abc"));
    files.set(
      "manifest.json",
      Buffer.from('{"layoutVersion":1,"formatVersion":1,"modelVersion":2,"projectId":"project"}'),
    );

    expect(() => decodeSnapshotData(files)).toThrow(
      expect.objectContaining({ code: "GIT_INVALID_SNAPSHOT" }),
    );
    const legacy = encodeLayoutOneFixture(snapshot("\ud800"));
    const [path] = recordFile(legacy, "comments");
    legacy.set(path.replace("record.json", "body.md"), Buffer.from("подмешанный blob"));
    expect(() => decodeSnapshotData(legacy)).toThrow(
      expect.objectContaining({ code: "GIT_INVALID_SNAPSHOT" }),
    );
  });

  test("layout 1 читает прежние exact bytes и не требует новых descriptors", () => {
    const value = snapshot("abc");
    const files = encodeLayoutOneFixture(value);
    const [entityPath] = recordFile(files, "entities");
    const [commentPath] = recordFile(files, "comments");

    expect(entityPath).toBe(
      "entities/bca3685fea8acd4e4b5c149874e1aa2bad0708e7e5ed490f3cf0702cb7a8bb56/record.json",
    );
    expect(Buffer.from(files.get(entityPath) ?? []).toString()).toBe(
      '{"entity":{"record":{"createdAt":"2026-01-01T00:00:00.000Z","createdBy":"Автор","data":{"name":"Документ"},"id":"entity","key":"doc-1","kind":"document","updatedAt":"2026-01-01T00:00:00.000Z","updatedBy":"Автор"},"version":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"},"markdown":["body"]}\n',
    );
    expect(Buffer.from(files.get(commentPath) ?? []).toString()).toBe(
      '{"after":null,"comment":{"createdAt":"2026-01-01T00:00:00.000Z","createdBy":"Автор","id":"comment","title":""},"taskId":"task"}\n',
    );
    expect(decodeSnapshotData(files)).toEqual(value);
    expect(decodeSnapshotData(encodeLayoutOneFixture(snapshot("\ud800")))).toEqual(
      snapshot("\ud800"),
    );
  });
});
