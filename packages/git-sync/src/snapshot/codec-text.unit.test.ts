import { describe, expect, test } from "bun:test";
import { createCodecSnapshot, readCodecRow } from "./codec.unit-fixture";
import { decodeSnapshotData, encodeSnapshot } from "./files";

const texts = [
  { name: "пустая строка", body: "", carrier: null },
  { name: "без конечного LF", body: "abc", carrier: null },
  { name: "BOM, CRLF, tabs и пробелы", body: "\ufeff# Текст\r\n\tСтрока  \r\n", carrier: null },
  { name: "декомпозированный Unicode и surrogate pair", body: "e\u0301🙂", carrier: null },
  {
    name: "непарные surrogate",
    body: "до\ud800/\udfffпосле",
    carrier: '"до\\ud800/\\udfffпосле"',
  },
];

describe("Точные тексты в JSON строках таблиц", () => {
  test.each(texts)("$name сохраняется вместе со строкой владельца", ({ body, carrier }) => {
    const snapshot = createCodecSnapshot(body);

    const files = encodeSnapshot(snapshot);
    const restored = decodeSnapshotData(files);

    expect(restored).toEqual(snapshot);
    for (const [table, field] of [
      ["documents", "body"],
      ["task_criteria", "description"],
      ["task_comments", "body"],
    ] as const) {
      const [, row] = readCodecRow(files, table);
      expect(row[field]).toBe(carrier === null ? body : null);
      expect(row[`${field}_json`]).toBe(carrier);
      expect(row).not.toHaveProperty("markdown");
      expect(row).not.toHaveProperty("data");
      expect(row).not.toHaveProperty("value");
    }
    expect([...files.keys()].every((path) => path.endsWith(".json"))).toBe(true);
  });

  test("неверные UTF-8 bytes строки отвергаются до чтения Storage", () => {
    const files = encodeSnapshot(createCodecSnapshot());
    const [path] = readCodecRow(files, "documents");
    files.set(path, Uint8Array.from([0x7b, 0x22, 0xed, 0xa0, 0x80, 0x22, 0x7d]));

    expect(() => decodeSnapshotData(files)).toThrow(
      expect.objectContaining({ code: "GIT_INVALID_SNAPSHOT" }),
    );
  });

  test("старый соседний Markdown blob не игнорируется", () => {
    const files = encodeSnapshot(createCodecSnapshot());
    files.set("documents/body.md", Buffer.from("постороннее содержание"));

    expect(() => decodeSnapshotData(files)).toThrow(
      expect.objectContaining({ code: "GIT_INVALID_SNAPSHOT" }),
    );
  });
});
