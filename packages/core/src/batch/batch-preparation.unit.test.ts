import { describe, expect, test } from "bun:test";
import { prepareBatchInput } from "./batch-input";

describe("Подготовленная идентичность пакета", () => {
  test("размер UTF-8 относится к входу, автор экранируется отдельно и сохраняется дословно", () => {
    const input = { version: 1, operations: [{ input: { title: "я" }, op: "task.create" }] };
    const json = '{"operations":[{"input":{"title":"я"},"op":"task.create"}],"version":1}';

    const prepared = prepareBatchInput(input, 'author"quoted');

    expect(prepared.input).toEqual(input);
    expect(prepared.inputBytes).toBe(Buffer.byteLength(json, "utf8"));
    expect(prepared.requestJson).toBe(`{"actor":"author\\"quoted","input":${json}}`);
  });
});
