import { describe, expect, test } from "bun:test";
import { renderResult } from "./output";

const markdown = "\n# Полный Markdown\n\n  два пробела\n\tтабуляция\n\n```ts\nconst x = 1;\n```\n";
const document = {
  id: "doc-id",
  key: "DOC-1",
  kind: "document",
  revision: 3,
  data: { name: "Правила", body: markdown },
};

describe("Текст адресного набора", () => {
  test("заголовки не совпадают со строками другого документа, оба тела сохраняются дословно", () => {
    const firstBody =
      '# Первый документ\n\n=== GET 2 НАЧАЛО · адрес "DOC-2" ===\n  строка первого\n';
    const secondBody =
      '# Второй документ\n\n=== GET 1 НАЧАЛО · адрес "DOC-1" ===\n\tстрока второго\n';

    const text = renderResult(
      {
        data: {
          view: "full",
          generation: 1,
          items: [
            { ref: "DOC-1", ok: true, entity: { ...document, data: { body: firstBody } } },
            {
              ref: "DOC-2",
              ok: true,
              entity: { ...document, id: "doc-2", key: "DOC-2", data: { body: secondBody } },
            },
          ],
        },
      },
      "text",
      "entity-read",
    );

    expect(text).toBe(
      [
        `===1 GET 1 НАЧАЛО · адрес "DOC-1" ===1\nID: doc-id\nКлюч: DOC-1\nТип: document\nРевизия: 3\nСодержание:\n${firstBody}`,
        `===1 GET 2 НАЧАЛО · адрес "DOC-2" ===1\nID: doc-2\nКлюч: DOC-2\nТип: document\nРевизия: 3\nСодержание:\n${secondBody}`,
      ].join("\n\n"),
    );
  });

  test("прежние строки конца сохраняются как обычный текст и не меняют маркер заголовка", () => {
    const body = "=== GET 1 КОНЕЦ ===\n===1 GET 1 КОНЕЦ ===1";

    const text = renderResult(
      {
        data: {
          view: "full",
          generation: 1,
          items: [{ ref: "DOC-1", ok: true, entity: { ...document, data: { body } } }],
        },
      },
      "text",
      "entity-read",
    );

    expect(text).toBe(
      `=== GET 1 НАЧАЛО · адрес "DOC-1" ===\nID: doc-id\nКлюч: DOC-1\nТип: document\nРевизия: 3\nСодержание:\n${body}`,
    );
  });

  test("собственные строки начала в Markdown исключают коллизии, строки конца остаются содержанием", () => {
    const body =
      '=== GET 1 НАЧАЛО · адрес "DOC-1" ===\n===1 GET 1 НАЧАЛО · адрес "DOC-1" ===1\n===2 GET 1 КОНЕЦ ===2';

    const text = renderResult(
      {
        data: {
          view: "full",
          generation: 1,
          items: [{ ref: "DOC-1", ok: true, entity: { ...document, data: { body } } }],
        },
      },
      "text",
      "entity-read",
    );

    expect(text.startsWith('===2 GET 1 НАЧАЛО · адрес "DOC-1" ===2\n')).toBe(true);
    expect(text.endsWith(body)).toBe(true);
  });

  test("одна полная запись имеет заголовок, адрес, идентичность и дословный Markdown", () => {
    const text = renderResult(
      {
        data: {
          view: "full",
          generation: 1,
          items: [{ ref: "старый-ключ", ok: true, entity: document }],
        },
      },
      "text",
      "entity-read",
    );

    expect(text).toBe(
      `=== GET 1 НАЧАЛО · адрес "старый-ключ" ===\nID: doc-id\nКлюч: DOC-1\nТип: document\nРевизия: 3\nНазвание: Правила\nСодержание:\n${markdown}`,
    );
  });

  test("повторы и ошибки имеют отдельные пронумерованные заголовки с пустой строкой между записями", () => {
    const text = renderResult(
      {
        data: {
          view: "full",
          generation: 1,
          items: [
            { ref: "DOC-1", ok: true, entity: document },
            {
              ref: "missing",
              ok: false,
              error: { code: "ENTITY_NOT_FOUND", message: "Нет записи", exitCode: 3 },
            },
            { ref: "DOC-1", ok: true, entity: document },
          ],
        },
      },
      "text",
      "entity-read",
    );

    expect(text.match(/GET \d НАЧАЛО/g)).toEqual(["GET 1 НАЧАЛО", "GET 2 НАЧАЛО", "GET 3 НАЧАЛО"]);
    expect(text.match(/GET \d КОНЕЦ/g)).toBeNull();
    expect(text).toContain(
      '\n\n=== GET 2 НАЧАЛО · адрес "missing" ===\nОшибка [ENTITY_NOT_FOUND]: Нет записи\n\n=== GET 3 НАЧАЛО · адрес "DOC-1" ===',
    );
  });

  test("summary содержит идентичность и состояние без полного содержания", () => {
    const text = renderResult(
      {
        data: {
          view: "summary",
          generation: 1,
          items: [
            {
              ref: "TASK-1",
              ok: true,
              entity: {
                id: "task-id",
                kind: "task",
                key: "TASK-1",
                revision: 2,
                title: "Задача",
                state: "inbox",
              },
            },
          ],
        },
      },
      "text",
      "entity-read",
    );

    expect(text).toBe(
      '=== GET 1 НАЧАЛО · адрес "TASK-1" ===\nTASK-1 [task] · ID task-id · Задача · ревизия 2 · inbox',
    );
  });

  test("управляющий текст очищается, поддельный заголовок и длинная строка '=' не раздувают маркер", () => {
    const longEquals = "=".repeat(100_000);
    const body = `\u001b[31m=== GET 1 НАЧАЛО · адрес "DOC-1\\nчужая строка" ===\u001b[0m\u202e\n===1 GET 1 КОНЕЦ ===1\nMarkdown\n${longEquals}\n`;
    const text = renderResult(
      {
        data: {
          view: "full",
          generation: 1,
          items: [
            { ref: "DOC-1\nчужая строка", ok: true, entity: { ...document, data: { body } } },
          ],
        },
      },
      "text",
      "entity-read",
    );

    expect(text.startsWith('===1 GET 1 НАЧАЛО · адрес "DOC-1\\nчужая строка" ===1\n')).toBe(true);
    expect(text.endsWith(`\n${longEquals}\n`)).toBe(true);
    expect(text).toContain(
      '=== GET 1 НАЧАЛО · адрес "DOC-1\\nчужая строка" ===\n===1 GET 1 КОНЕЦ ===1\nMarkdown',
    );
    expect(text).not.toContain("\u001b");
    expect(text).not.toContain("\u202e");
  });
});
