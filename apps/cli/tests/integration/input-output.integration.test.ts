import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { KnowledgeService } from "@relay/core";
import { withCliFixture } from "./helpers/cli-fixture";

const invalidSources = [
  {
    name: "два источника поля",
    argv: ["document", "create", "--name", "Два", "--body", "A", "--body-file", "-"],
    code: "CONFLICTING_OPTIONS",
  },
  {
    name: "два потребителя stdin",
    argv: ["document", "create", "--name", "Два stdin", "--body-file", "-", "--summary-file", "-"],
    code: "CONFLICTING_OPTIONS",
  },
  {
    name: "JSON вместе с отдельным полем",
    argv: ["document", "create", "--input", "{}", "--name", "Конфликт"],
    code: "CONFLICTING_OPTIONS",
  },
  {
    name: "отсутствующий файл",
    argv: ["document", "create", "--name", "Ошибка", "--body-file", "missing.md"],
    code: "INPUT_READ_FAILED",
  },
] as const;
const unknownJsonFields = [
  {
    name: "inline JSON задачи",
    argv: ["task", "create", "--input", '{"title":"Не сохранять","unknown":true}'],
    stdin: "",
    kind: "task",
  },
  {
    name: "JSON документа из stdin",
    argv: ["document", "create", "--input-file", "-"],
    stdin: '{"name":"Не сохранять","body":"Текст","unknown":true}',
    kind: "document",
  },
] as const;
const explicitEmptyValues = [
  {
    name: "отдельные флаги",
    argv: ["--pinned=false", "--summary", ""],
    stdin: "",
  },
  {
    name: "общий JSON из stdin",
    argv: ["--input-file", "-"],
    stdin: '{"pinned":false,"summary":""}',
  },
] as const;
const longMarkdown = "## Полное содержание\n\n" + "    Проверяемая строка\n".repeat(4_000);
const unsafeBody = longMarkdown + "\u001b[31mКОНЕЦ\u001b[0m\u202e";

describe("Файлы и JSON на входе CLI", () => {
  test("относительный UTF-8 файл сохраняется целиком в созданном документе", async () => {
    await withCliFixture(async (cli) => {
      const project = cli.createProject();
      const body = "## Из файла\n\n  отступ\n";
      writeFileSync(join(cli.runtime.cwd, "body.md"), body);

      const document = await cli.entity([
        "document",
        "create",
        "--name",
        "Файл",
        "--body-file",
        "body.md",
      ]);

      expect(document.data.body).toBe(body);
      expect(cli.withDatabase(project, (db) => db.get(document.id)?.data.body)).toBe(body);
    });
  });

  test("stdin обновления сохраняет значимые начальный и завершающий переводы строк", async () => {
    await withCliFixture(async (cli) => {
      const project = cli.createProject();
      const document = cli.withDatabase(project, (db) =>
        new KnowledgeService(db).create(
          "document",
          { name: "Исходный", body: "Заменяемый текст" },
          "fixture",
        ),
      );
      const body = "\n# stdin\n";

      const updated = await cli.entity(
        [
          "document",
          "update",
          document.key,
          "--body-file",
          "-",
          "--if-revision",
          String(document.revision),
        ],
        { stdin: body },
      );

      expect(updated.data.body).toBe(body);
      expect(cli.withDatabase(project, (db) => db.get(document.id)?.data.body)).toBe(body);
    });
  });

  test.each(explicitEmptyValues)(
    "$name: false и пустая строка очищают поля, сохраняя тело документа",
    async ({ argv, stdin }) => {
      await withCliFixture(async (cli) => {
        const project = cli.createProject();
        const document = cli.withDatabase(project, (db) =>
          new KnowledgeService(db).create(
            "document",
            { name: "Закреплённый", pinned: true, summary: "Исходное описание", body: "Тело" },
            "fixture",
          ),
        );

        const updated = await cli.entity(
          ["document", "update", document.key, "--if-revision", String(document.revision), ...argv],
          { stdin },
        );

        expect(updated.id).toBe(document.id);
        expect(updated.revision).toBe(document.revision + 1);
        expect(updated.data).toEqual({ ...document.data, pinned: false, summary: "" });
        expect(cli.withDatabase(project, (db) => db.get(document.id))).toEqual(updated);
      });
    },
  );

  test.each(invalidSources)(
    "$name отклоняется до чтения stdin и записи данных",
    async ({ argv, code }) => {
      await withCliFixture(async (cli) => {
        const project = cli.createProject();
        const generation = cli.withDatabase(project, (db) => db.getGeneration());
        let reads = 0;

        const error = await cli.error(argv, 2, {
          /**
           * Отмечает чтение stdin, которое конфликт или отсутствующий файл должны предотвратить.
           */
          stdin: (): string => {
            reads++;
            return "Не сохранять";
          },
        });

        expect(error.code).toBe(code);
        expect(reads).toBe(0);
        expect(cli.withDatabase(project, (db) => db.getGeneration())).toBe(generation);
        expect(cli.withDatabase(project, (db) => db.list("document"))).toEqual([]);
      });
    },
  );

  test.each(unknownJsonFields)(
    "$name с неизвестным полем не изменяет проект",
    async ({ argv, stdin, kind }) => {
      await withCliFixture(async (cli) => {
        const project = cli.createProject();
        const generation = cli.withDatabase(project, (db) => db.getGeneration());

        const error = await cli.error(argv, 2, { stdin });

        expect(error.code).toBe("INVALID_ARGUMENT");
        expect(cli.withDatabase(project, (db) => db.getGeneration())).toBe(generation);
        expect(cli.withDatabase(project, (db) => db.list(kind))).toEqual([]);
      });
    },
  );

  test("ID раздела в JSON не подменяет позиционный ID и не изменяет проект", async () => {
    await withCliFixture(async (cli) => {
      const project = cli.createProject();
      const before = cli.withDatabase(project, (db) => ({
        generation: db.getGeneration(),
        project: new KnowledgeService(db).get("project"),
      }));

      const error = await cli.error(
        [
          "document",
          "section",
          "create",
          "local",
          "--input",
          '{"id":"ignored","name":"Не сохранять"}',
          "--if-revision",
          String(before.project.revision),
        ],
        2,
      );

      expect(error.code).toBe("INVALID_ARGUMENT");
      expect(cli.withDatabase(project, (db) => db.getGeneration())).toBe(before.generation);
      expect(cli.withDatabase(project, (db) => db.get(project.projectId))).toEqual(before.project);
    });
  });
});

describe("Полное и краткое представление CLI", () => {
  test("полный get в JSON сохраняет длинный Markdown и исходные управляющие символы", async () => {
    await withCliFixture(async (cli) => {
      const project = cli.createProject();
      const document = cli.withDatabase(project, (db) =>
        new KnowledgeService(db).create("document", { name: "Длинный", body: unsafeBody }, "agent"),
      );

      const result = await cli.entity(["document", "get", document.key]);

      expect(result.data.body).toBe(unsafeBody);
    });
  });

  test("полный get в text обезвреживает терминальные контролы без обрезки Markdown", async () => {
    await withCliFixture(async (cli) => {
      const project = cli.createProject();
      const document = cli.withDatabase(project, (db) =>
        new KnowledgeService(db).create("document", { name: "Длинный", body: unsafeBody }, "agent"),
      );

      const text = await cli.invoke(["document", "get", document.key]);

      expect(text).toMatchObject({ code: 0, stderr: "" });
      expect(text.stdout).toContain(longMarkdown + "КОНЕЦ");
      expect(text.stdout).not.toContain("\u001b");
      expect(text.stdout).not.toContain("\u202e");
    });
  });

  test("список документов выводит краткую карточку с адресом без полного Markdown", async () => {
    await withCliFixture(async (cli) => {
      const project = cli.createProject();
      const body = "Полное скрытое содержание документа";
      const document = cli.withDatabase(project, (db) =>
        new KnowledgeService(db).create("document", { name: "Краткая карточка", body }, "agent"),
      );

      const text = await cli.invoke(["document", "list"]);

      expect(text).toMatchObject({ code: 0, stderr: "" });
      expect(text.stdout).toContain(document.key);
      expect(text.stdout).toContain("Краткая карточка");
      expect(text.stdout).not.toContain(body);
    });
  });
});
