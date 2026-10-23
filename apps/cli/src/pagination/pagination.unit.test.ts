import { describe, expect, test } from "bun:test";
import { paginate } from "./pagination";
import type { Page, PageSelection, PageWindow, PaginationOptions } from "./pagination.types";

const incompatibleCursors = [
  {
    name: "другой запрос",
    overrides: { query: "другой запрос" },
    code: "INVALID_CURSOR",
    message: "другому проекту или запросу",
  },
  {
    name: "другой проект",
    overrides: { context: "project-b" },
    code: "INVALID_CURSOR",
    message: "другому проекту или запросу",
  },
  {
    name: "новое поколение",
    overrides: { generation: 5 },
    code: "SNAPSHOT_CONFLICT",
    message: "Данные изменились",
  },
  {
    name: "другой явно заданный размер страницы",
    overrides: { limit: 2 },
    code: "INVALID_CURSOR",
    message: "другому проекту или запросу",
  },
] as const;

/**
 * Создаёт независимые параметры страницы с одним элементом для проверки продолжения списка.
 */
function paginationOptions(): PaginationOptions {
  return {
    context: "project-a",
    query: ["task list", { column: "ready" }],
    generation: 4,
    limit: 1,
    explicitLimit: true,
    /**
     * Формирует команду продолжения для переданного курсора.
     */
    command: (cursor: string): string => {
      return `relay task list --cursor ${cursor}`;
    },
  };
}

/**
 * Требует непустой курсор у страницы, в которой fixture оставила непрочитанные элементы.
 */
function nextCursor(page: Page): string {
  const cursor = page.nextCursor;
  if (typeof cursor !== "string" || cursor.length === 0) {
    throw new Error("Ожидался курсор продолжения непустого списка");
  }
  return cursor;
}

describe("Курсор страницы CLI", () => {
  test("продолжение без явного limit сохраняет размер первой страницы", () => {
    const options = paginationOptions();
    const first = paginate(["a", "b", "c"], options);
    const cursor = nextCursor(first.page);

    const second = paginate(["a", "b", "c"], {
      ...options,
      cursor,
      limit: 20,
      explicitLimit: false,
    });

    expect(second.items).toEqual(["b"]);
    expect(second.page.limit).toBe(1);
  });

  test.each(incompatibleCursors)(
    "$name: несовместимый курсор отклоняется с $code",
    ({ overrides, code, message }) => {
      const options = paginationOptions();
      const cursor = nextCursor(paginate(["a", "b"], options).page);

      expect(() => paginate(["a", "b"], { ...options, cursor, ...overrides })).toThrow(
        expect.objectContaining({ code, message: expect.stringContaining(message) }),
      );
    },
  );

  test("повреждённая контрольная сумма курсора отклоняется с INVALID_CURSOR", () => {
    const options = paginationOptions();
    const cursor = nextCursor(paginate(["a", "b"], options).page);

    expect(() => paginate(["a", "b"], { ...options, cursor: cursor + "x" })).toThrow(
      expect.objectContaining({ code: "INVALID_CURSOR", message: "Повреждённый курсор страницы" }),
    );
  });

  test("ленивый источник получает только последовательные окна до конца списка", () => {
    const options = paginationOptions();
    const windows: PageWindow[] = [];
    /**
     * Записывает запрошенное окно и возвращает одну подготовленную строку без полного списка.
     */
    const readWindow = (window: PageWindow): PageSelection<string> => {
      windows.push(window);
      return { items: [window.offset === 0 ? "a" : "b"], total: 2 };
    };

    const first = paginate(readWindow, options);
    const second = paginate(readWindow, { ...options, cursor: nextCursor(first.page) });

    expect(windows).toEqual([
      { offset: 0, limit: 1 },
      { offset: 1, limit: 1 },
    ]);
    expect(second.items).toEqual(["b"]);
    expect(second.page.nextCursor).toBeNull();
  });

  test("метаданные владельца возвращаются из источника даже для пустого окна", () => {
    const owner = Object.freeze({ plan: "PLN-1", revision: 4 });
    const selection = { items: [], total: 0, owner };

    const page = paginate(() => selection, paginationOptions());

    expect(page.owner).toEqual({ plan: "PLN-1", revision: 4 });
    expect(page.items).toEqual([]);
    expect(page.page).toMatchObject({ total: 0, count: 0, nextCursor: null });
    expect(selection).toEqual({ items: [], total: 0, owner: { plan: "PLN-1", revision: 4 } });
  });

  test("устаревший курсор отклоняется до обращения к ленивому источнику", () => {
    const options = paginationOptions();
    const cursor = nextCursor(paginate(["a", "b"], options).page);
    let reads = 0;
    /**
     * Считает обращения к источнику, запрещённые при конфликте поколения.
     */
    const readWindow = (): PageSelection<string> => {
      reads++;
      return { items: ["b"], total: 2 };
    };

    expect(() => paginate(readWindow, { ...options, cursor, generation: 5 })).toThrow(
      expect.objectContaining({
        code: "SNAPSHOT_CONFLICT",
        message: expect.stringContaining("Данные изменились"),
      }),
    );

    expect(reads).toBe(0);
  });
});
