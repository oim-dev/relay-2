import { describe, expect, test } from "bun:test";
import { renderResult } from "./output";
import { terminalText } from "./terminal";
import type { Page } from "../pagination/pagination.types";

const unsafeText =
  "## Заголовок\n\n\t👩‍💻 код\r\n\u001b[31mцвет\u001b[0m\u001b]8;;https://invalid.local\u0007ссылка\u001b]8;;\u0007\u0008\u0085\u202eхвост";
const longBody = "# Полный текст\n\n" + "    строка с отступом\n".repeat(20_000) + "КОНЕЦ";
const singlePage: Page = {
  count: 1,
  total: 1,
  limit: 20,
  nextCursor: null,
  nextCommand: null,
  consistency: "snapshot",
};

describe("Представление результата CLI", () => {
  test("текстовый список workspace показывает имя один раз и сохраняет пробелы пути", () => {
    const rendered = renderResult(
      {
        data: { items: [{ name: "commerce", path: "/projects/Мой  проект" }] },
        meta: { page: singlePage },
      },
      "text",
      "workspace-projects",
    );

    expect(rendered).toBe("commerce · /projects/Мой  проект\n\nПоказано 1 из 1.");
  });

  test("обычный список сохраняет отличающиеся ID и заголовок", () => {
    const rendered = renderResult(
      {
        data: { items: [{ id: "criterion-1", title: "Проверить", completed: false }] },
        meta: { page: singlePage },
      },
      "text",
    );

    expect(rendered).toBe("criterion-1 · Проверить · не выполнено\n\nПоказано 1 из 1.");
  });

  test("терминальный текст обезвреживает ANSI/OSC, C0/C1 и bidi, сохраняя Markdown и Unicode", () => {
    const rendered = terminalText(unsafeText);

    expect(rendered).toBe("## Заголовок\n\n\t👩‍💻 код\nцветссылкахвост");
  });

  test("JSON сохраняет исходные управляющие символы как данные", () => {
    const result = { data: { body: unsafeText } };

    const rendered = renderResult(result, "json");

    const decoded: unknown = JSON.parse(rendered);
    expect(decoded).toEqual({ ok: true, data: { body: unsafeText } });
  });

  test("полное текстовое представление не обрезает длинное содержание", () => {
    const result = { data: { body: longBody } };

    const rendered = renderResult(result, "text");

    expect(rendered).toContain(longBody);
  });

  test("полное JSON-представление не обрезает длинное содержание", () => {
    const result = { data: { body: longBody } };

    const rendered = renderResult(result, "json");

    const decoded: unknown = JSON.parse(rendered);
    expect(decoded).toEqual({ ok: true, data: { body: longBody } });
  });
});

describe("Предметные макеты CLI", () => {
  test("конфигурация отделяет сохранённый override от вычисленных путей и сохраняет расширения", () => {
    const result = {
      data: {
        version: 1,
        projectId: "project-id",
        databasePath: "../данные/base.sqlite",
        custom: 7,
      },
      meta: { configPath: "/проект/relay.config.json", databasePath: "/данные/base.sqlite" },
    };

    const rendered = renderResult(result, "text", "configuration");

    expect(rendered).toBe(
      "Исходная конфигурация\n" +
        "Версия конфигурации: 1\nID проекта: project-id\n" +
        "Путь базы в конфиге (переопределение): ../данные/base.sqlite\ncustom: 7\n\n" +
        "Вычисленное расположение\nКонфигурация: /проект/relay.config.json\n" +
        "База данных: /данные/base.sqlite",
    );
    expect(JSON.parse(renderResult(result, "json", "configuration"))).toEqual({
      ok: true,
      ...result,
    });
  });

  test("комментарии без заголовка и с заголовком показывают автора и полный Markdown страницы", () => {
    const body = "\n  # Обсуждение\n\n    код  \n\tстрока\n";
    const result = {
      data: {
        task: "PRODUCT-1",
        revision: 8,
        items: [
          {
            id: "comment-1",
            title: "",
            body,
            createdBy: "writer-1",
            createdAt: "2026-10-23T10:00:00Z",
          },
          {
            id: "comment-2",
            title: "  Детали  ",
            body: longBody,
            createdBy: "writer-2",
            createdAt: "2026-10-23T11:00:00Z",
          },
        ],
      },
      meta: {
        page: {
          ...singlePage,
          count: 2,
          total: 3,
          limit: 2,
          nextCursor: "cursor",
          nextCommand: "relay task comment list PRODUCT-1 --limit=2 --cursor=cursor",
        },
      },
    };

    const rendered = renderResult(result, "text", "task-comments");

    expect(rendered).toBe(
      "Задача: PRODUCT-1\nРевизия: 8\n\n" +
        "Комментарий: comment-1\nАвтор: writer-1\nСоздано: 2026-10-23T10:00:00Z\nСодержание:\n" +
        body +
        "\n\nКомментарий: comment-2\nЗаголовок:   Детали  \n" +
        "Автор: writer-2\nСоздано: 2026-10-23T11:00:00Z\nСодержание:\n" +
        longBody +
        "\n\nПоказано 2 из 3.\n" +
        "Продолжение: relay task comment list PRODUCT-1 --limit=2 --cursor=cursor",
    );
    expect(JSON.parse(renderResult(result, "json", "task-comments"))).toEqual({
      ok: true,
      ...result,
    });
  });

  test("пустой журнал сохраняет владельца и не предлагает несуществующее продолжение", () => {
    const rendered = renderResult(
      {
        data: { task: "PRODUCT-1", revision: 8, items: [] },
        meta: { page: { ...singlePage, count: 0, total: 0 } },
      },
      "text",
      "task-comments",
    );

    expect(rendered).toBe("Задача: PRODUCT-1\nРевизия: 8\n\nЗаписей нет.\n\nПоказано 0 из 0.");
  });

  test("снятая реализация отличается от действующей с тем же статусом", () => {
    const rendered = renderResult(
      {
        data: {
          items: [
            {
              kind: "implementation",
              key: "WEB-FI-1",
              revision: 2,
              data: { title: "Поиск", status: "done", active: true },
            },
            {
              kind: "implementation",
              key: "WEB-SI-1",
              revision: 5,
              data: { title: "Фильтр", status: "done", active: false },
            },
          ],
        },
        meta: { page: { ...singlePage, count: 2, total: 2 } },
      },
      "text",
    );

    expect(rendered).toBe(
      "WEB-FI-1 · Поиск · ревизия 2 · done\n" +
        "WEB-SI-1 · Фильтр · ревизия 5 · done · участие снято\n\nПоказано 2 из 2.",
    );
  });

  test("дерево сохраняет родителей двух веток и внука без перестановки окна", () => {
    const result = {
      data: {
        items: [
          {
            id: "root",
            kind: "work-session",
            key: "CUSTOM-ROOT",
            revision: 5,
            data: { title: "Корневая работа", status: "open", parentSessionId: null },
          },
          {
            id: "left",
            kind: "work-session",
            key: "S-LEFT",
            revision: 2,
            data: { title: "Левая ветка", status: "open", parentSessionId: "root" },
          },
          {
            id: "right",
            kind: "work-session",
            key: "S-RIGHT",
            revision: 3,
            data: { title: "Правая ветка", status: "cancelled", parentSessionId: "root" },
          },
          {
            id: "grandchild",
            kind: "work-session",
            key: "S-GRANDCHILD",
            revision: 1,
            data: { title: "Частный случай", status: "pending", parentSessionId: "left" },
          },
        ],
      },
      meta: { page: { ...singlePage, count: 4, total: 4 } },
    };

    const rendered = renderResult(result, "text", "session-tree");

    expect(rendered).toBe(
      "CUSTOM-ROOT · Корневая работа · ревизия 5 · open · корень\n" +
        "S-LEFT · Левая ветка · ревизия 2 · open\n  Родительская сессия: CUSTOM-ROOT\n" +
        "S-RIGHT · Правая ветка · ревизия 3 · cancelled\n  Родительская сессия: CUSTOM-ROOT\n" +
        "S-GRANDCHILD · Частный случай · ревизия 1 · pending\n  Родительская сессия: S-LEFT\n\n" +
        "Показано 4 из 4.",
    );
    expect(JSON.parse(renderResult(result, "json", "session-tree"))).toEqual({
      ok: true,
      ...result,
    });
  });

  test("дерево на средней странице сохраняет ID внешнего родителя и полную команду продолжения", () => {
    const rendered = renderResult(
      {
        data: {
          items: [
            {
              id: "child",
              kind: "work-session",
              key: "S-CHILD",
              revision: 1,
              data: {
                title: " Дочерняя  работа ",
                status: "pending",
                parentSessionId: "parent-uuid",
              },
            },
          ],
        },
        meta: {
          page: {
            ...singlePage,
            total: 4,
            limit: 1,
            nextCursor: "next",
            nextCommand:
              "relay session tree S-ROOT --config='/мой проект/relay.config.json' --limit=1 --cursor=next",
          },
        },
      },
      "text",
      "session-tree",
    );

    expect(rendered).toBe(
      "S-CHILD ·  Дочерняя  работа  · ревизия 1 · pending\n" +
        "  Родительская сессия (ID, вне страницы): parent-uuid\n\nПоказано 1 из 4.\n" +
        "Продолжение: relay session tree S-ROOT --config='/мой проект/relay.config.json' --limit=1 --cursor=next",
    );
  });

  test("контрольная точка различает свою ревизию и историческую ревизию сессии", () => {
    const rendered = renderResult(
      {
        data: {
          kind: "work-checkpoint",
          key: "CP-1",
          revision: 1,
          data: { sessionRevision: 4, sequence: 2, acceptedSessionIds: ["child-id"] },
        },
      },
      "text",
    );

    expect(rendered).toBe(
      "Тип: work-checkpoint\nКлюч: CP-1\nРевизия контрольной точки: 1\n" +
        "Ревизия сессии при записи: 4\nПорядковый номер в сессии: 2\n" +
        "Принятые дочерние сессии (ID): - child-id",
    );
  });

  test("релиз подписывает выпуск и готовность, не переименовывая version произвольного DTO", () => {
    const release = renderResult(
      {
        data: {
          kind: "release",
          key: "REL-1",
          revision: 3,
          data: { version: "1.2.1", plannedFor: "2028-02-29", releasedAt: null, releasedBy: null },
        },
      },
      "text",
    );
    const progress = renderResult(
      {
        data: {
          release: "REL-1",
          canRelease: false,
          total: 2,
          completed: 1,
          percent: 50,
          plans: [],
        },
      },
      "text",
    );

    expect(release).toBe(
      "Тип: release\nКлюч: REL-1\nРевизия: 3\nВерсия выпуска: 1.2.1\n" +
        "Плановая дата: 2028-02-29\nВремя выпуска: —\nАвтор выпуска: —",
    );
    expect(progress).toBe(
      "Релиз: REL-1\nМожно выпустить: нет\nВсего: 2\nВыполнено: 1\nПроцент: 50\nПланы: нет",
    );
    expect(renderResult({ data: { version: 1 } }, "text")).toBe("version: 1");
  });
});
