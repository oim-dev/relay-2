import { describe, expect, test } from "bun:test";
import { flag, inputArgs, jsonArgs, textArgs } from "./arguments";
import { readInput } from "./input";
import type { CliRuntime } from "../execution/runtime.types";

const runtime: CliRuntime = { cwd: "/", env: {}, stdin: "  # Текст\n\n    код\n" };
const conflictingSources = [
  {
    name: "два источника одного поля",
    input: { body: "inline", "body-file": "-" },
    message: "несовместимы",
  },
  {
    name: "два потребителя stdin",
    input: { "body-file": "-", "summary-file": "-" },
    message: "только одно поле",
  },
  {
    name: "общий JSON и отдельное поле",
    input: { input: "{}", "body-file": "-" },
    message: "нельзя смешивать",
  },
] as const;

describe("Источники ввода CLI", () => {
  test.each(conflictingSources)("$name отклоняются до чтения stdin", async ({ input, message }) => {
    let reads = 0;
    const context: CliRuntime = {
      ...runtime,
      /**
       * Отмечает любое чтение stdin, запрещённое до разрешения конфликта источников.
       */
      stdin: (): string => {
        reads++;
        return "";
      },
    };
    const fields = inputArgs(textArgs({ body: "Полный текст", summary: "Аннотация" }));

    await expect(readInput(input, fields, context)).rejects.toMatchObject({
      code: "CONFLICTING_OPTIONS",
      message: expect.stringContaining(message),
    });

    expect(reads).toBe(0);
  });

  test("текст из stdin сохраняет значимые пробелы вместе с пустым отдельным полем", async () => {
    const fields = textArgs({ body: "Полный текст", summary: "Аннотация" });

    const input = await readInput({ "body-file": "-", summary: "" }, fields, runtime);

    expect(input).toEqual({ body: runtime.stdin, summary: "" });
  });

  test("общий JSON сохраняет false и пустую строку", async () => {
    const fields = inputArgs({
      pinned: flag("Закрепление"),
      ...textArgs({ summary: "Аннотация" }),
    });

    const input = await readInput({ input: '{"pinned":false,"summary":""}' }, fields, runtime);

    expect(input).toEqual({ pinned: false, summary: "" });
  });

  test("массив вместо объекта общего ввода отклоняется с INVALID_JSON", async () => {
    const fields = inputArgs({});

    await expect(readInput({ input: "[]" }, fields, runtime)).rejects.toMatchObject({
      code: "INVALID_JSON",
      message: expect.stringContaining("JSON-объект"),
    });
  });

  test("структурированное поле из stdin разбирается по его JSON-схеме", async () => {
    const fields = jsonArgs("relations", "Связи");
    const context = { ...runtime, stdin: '[{"target":"FEATURE-1"}]' };

    const input = await readInput({ "relations-file": "-" }, fields, context);

    expect(input).toEqual({ relations: [{ target: "FEATURE-1" }] });
  });

  test("повреждённый JSON структурированного поля отклоняется с INVALID_JSON", async () => {
    const fields = jsonArgs("relations", "Связи");
    const context = { ...runtime, stdin: "{" };

    await expect(readInput({ "relations-file": "-" }, fields, context)).rejects.toMatchObject({
      code: "INVALID_JSON",
      message: expect.stringContaining("корректный JSON"),
    });
  });
});
