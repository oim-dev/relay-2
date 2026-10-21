import { describe, expect, test } from "bun:test";
import { flag, inputArgs, jsonArgs, readInput, textArgs } from "./arguments";
import { paginate } from "./pagination";
import type { CliRuntime } from "./runtime";

const runtime: CliRuntime = { cwd: "/", env: {}, stdin: "  # Текст\n\n    код\n" };

describe("Ввод CLI", () => {
  test("два источника поля и два потребителя stdin отклоняются до чтения", async () => {
    let reads = 0;
    const context = {
      ...runtime,
      stdin: () => {
        reads++;
        return "";
      },
    };
    const fields = inputArgs(textArgs("body", "summary"));
    await expect(readInput({ body: "inline", "body-file": "-" }, fields, context)).rejects.toThrow(
      "несовместимы",
    );
    await expect(
      readInput({ "body-file": "-", "summary-file": "-" }, fields, context),
    ).rejects.toThrow("только одно поле");
    await expect(readInput({ input: "{}", "body-file": "-" }, fields, context)).rejects.toThrow(
      "нельзя смешивать",
    );
    expect(reads).toBe(0);
  });
  test("значимые пробелы, пустые значения и false сохраняются", async () => {
    expect(
      await readInput({ "body-file": "-", summary: "" }, textArgs("body", "summary"), runtime),
    ).toEqual({ body: runtime.stdin, summary: "" });
    expect(
      await readInput(
        { input: '{"pinned":false,"summary":""}' },
        inputArgs({ pinned: flag("Закрепление"), ...textArgs("summary") }),
        runtime,
      ),
    ).toEqual({ pinned: false, summary: "" });
    await expect(readInput({ input: "[]" }, inputArgs({}), runtime)).rejects.toThrow("JSON-объект");
  });
  test("структурированные поля читаются из stdin с той же JSON-схемой", async () => {
    expect(
      await readInput({ "relations-file": "-" }, jsonArgs("relations", "Связи"), {
        ...runtime,
        stdin: '[{"target":"FEATURE-1"}]',
      }),
    ).toEqual({ relations: [{ target: "FEATURE-1" }] });
    await expect(
      readInput({ "relations-file": "-" }, jsonArgs("relations", "Связи"), {
        ...runtime,
        stdin: "{",
      }),
    ).rejects.toThrow("корректный JSON");
  });
});

describe("Пагинация CLI", () => {
  const options = {
    context: "project-a",
    query: ["task list", { column: "ready" }],
    generation: 4,
    limit: 1,
    explicitLimit: true,
    command: (cursor: string) => `relay task list --cursor ${cursor}`,
  };
  test("курсор сохраняет размер страницы, отказывает для другого запроса и поколения", () => {
    const first = paginate(["a", "b", "c"], options);
    const cursor = first.page.nextCursor!;
    expect(
      paginate(["a", "b", "c"], { ...options, cursor, limit: 20, explicitLimit: false }).items,
    ).toEqual(["b"]);
    expect(() => paginate(["a", "b"], { ...options, cursor, query: "другой запрос" })).toThrow(
      "другому проекту или запросу",
    );
    expect(() => paginate(["a", "b"], { ...options, cursor, context: "project-b" })).toThrow(
      "другому проекту или запросу",
    );
    expect(() => paginate(["a", "b"], { ...options, cursor, generation: 5 })).toThrow(
      "Данные изменились",
    );
    expect(() => paginate(["a", "b"], { ...options, cursor: cursor + "x" })).toThrow(
      "Повреждённый курсор",
    );
  });
  test("ленивое чтение получает только окно и не вызывается для устаревшего курсора", () => {
    const windows: { offset: number; limit: number }[] = [];
    const read = (window: { offset: number; limit: number }) => {
      windows.push(window);
      return { items: [window.offset === 0 ? "a" : "b"], total: 2 };
    };
    const first = paginate(read, options);
    const second = paginate(read, { ...options, cursor: first.page.nextCursor! });
    expect(windows).toEqual([
      { offset: 0, limit: 1 },
      { offset: 1, limit: 1 },
    ]);
    expect(second.items).toEqual(["b"]);
    expect(second.page.nextCursor).toBeNull();
    expect(() =>
      paginate(read, { ...options, cursor: first.page.nextCursor!, generation: 5 }),
    ).toThrow("Данные изменились");
    expect(windows).toHaveLength(2);
  });
});
