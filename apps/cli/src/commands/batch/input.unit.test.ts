import { describe, expect, test } from "bun:test";
import { readBatchInput } from "./input";

const input = {
  version: 1,
  operations: [
    { op: "document.create", input: { name: "Документ", body: "\n# Текст\n\n  код\n" } },
  ],
};

describe("Источник атомарного пакета", () => {
  test("inline JSON сохраняет Markdown и не читает stdin", async () => {
    const result = await readBatchInput(
      { input: JSON.stringify(input), check: true },
      {
        cwd: "/missing",
        env: {},
        /**
         * Запрещает чтение невыбранного источника.
         */
        stdin: (): never => {
          throw new Error("stdin не выбран");
        },
      },
    );

    expect(result).toEqual(input);
  });

  test("stdin читается ровно один раз, строки $ref внутри Markdown остаются буквальными", async () => {
    let reads = 0;
    const body = '{"$ref":"не-ссылка"}';
    const result = await readBatchInput(
      { input: "-", check: true },
      {
        cwd: "/missing",
        env: {},
        /**
         * Считает запросы единственного потребителя stdin.
         */
        stdin: (): string => {
          reads++;
          return JSON.stringify({
            version: 1,
            operations: [{ op: "document.create", input: { name: "Текст", body } }],
          });
        },
      },
    );

    expect(reads).toBe(1);
    expect(result).toMatchObject({ operations: [{ input: { body } }] });
  });

  test.each(["inline", "stdin"])("%s превышает 8 МиБ в UTF-8 до разбора JSON", async (source) => {
    const text = "я".repeat(4 * 1024 * 1024 + 1);

    await expect(
      readBatchInput(
        { input: source === "inline" ? text : "-", check: true },
        {
          cwd: "/missing",
          env: {},
          stdin: text,
        },
      ),
    ).rejects.toMatchObject({ code: "INPUT_TOO_LARGE", exitCode: 2 });
  });

  test("ровно 8 МиБ допускается к разбору", async () => {
    const text = "x".repeat(8 * 1024 * 1024 - 11);
    const json = JSON.stringify({ text });
    expect(Buffer.byteLength(json)).toBe(8 * 1024 * 1024);

    const result = await readBatchInput(
      { input: json, check: true },
      { cwd: "/missing", env: {}, stdin: "" },
    );

    expect(result).toEqual({ text });
  });
});
