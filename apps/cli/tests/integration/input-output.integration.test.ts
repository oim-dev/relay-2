import { expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { KnowledgeService } from "@relay/core";
import { withCliFixture } from "./helpers/cli-fixture";

test("относительный UTF-8 файл и stdin сохраняют полное содержание переданной команды", () =>
  withCliFixture(async (cli) => {
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
      { stdin: "\n# stdin\n" },
    );
    expect(updated.data.body).toBe("\n# stdin\n");
    expect(cli.withDatabase(project, (db) => db.get(document.id)!.data.body)).toBe(
      updated.data.body,
    );
  }));

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
];

test.each(invalidSources)("$name отклоняется до чтения stdin и записи данных", ({ argv, code }) =>
  withCliFixture(async (cli) => {
    const project = cli.createProject();
    const generation = cli.withDatabase(project, (db) => db.getGeneration());
    let reads = 0;
    const error = await cli.error(argv, 2, {
      stdin: () => {
        reads++;
        return "Не сохранять";
      },
    });
    expect(error.code).toBe(code);
    expect(reads).toBe(0);
    expect(cli.withDatabase(project, (db) => db.getGeneration())).toBe(generation);
  }),
);

test.each(["inline", "stdin", "позиционный ID"] as const)(
  "неизвестные JSON-поля (%s) не изменяют проект",
  (source) =>
    withCliFixture(async (cli) => {
      const project = cli.createProject();
      const before = cli.withDatabase(project, (db) => ({
        generation: db.getGeneration(),
        revision: db.get(project.projectId)!.revision,
      }));
      const argv =
        source === "inline"
          ? ["task", "create", "--input", '{"title":"Не сохранять","unknown":true}']
          : source === "stdin"
            ? ["document", "create", "--input-file", "-"]
            : [
                "document",
                "section",
                "create",
                "local",
                "--input",
                '{"id":"ignored","name":"Не сохранять"}',
                "--if-revision",
                String(before.revision),
              ];
      const error = await cli.error(argv, 2, {
        stdin: '{"name":"Не сохранять","body":"Текст","unknown":true}',
      });
      expect(error.code).toBe("INVALID_ARGUMENT");
      expect(cli.withDatabase(project, (db) => db.getGeneration())).toBe(before.generation);
    }),
);

test("полный get сохраняет длинный Markdown в JSON и обезвреживает терминальные контролы в text", () =>
  withCliFixture(async (cli) => {
    const project = cli.createProject();
    const body =
      "## Полное содержание\n\n" +
      "    Проверяемая строка\n".repeat(4_000) +
      "\u001b[31mКОНЕЦ\u001b[0m\u202e";
    const document = cli.withDatabase(project, (db) =>
      new KnowledgeService(db).create("document", { name: "Длинный", body }, "agent"),
    );
    expect((await cli.entity(["document", "get", document.key])).data.body).toBe(body);
    const text = await cli.invoke(["document", "get", document.key]);
    expect(text).toMatchObject({ code: 0, stderr: "" });
    expect(text.stdout).toContain(
      body.replace("\u001b[31m", "").replace("\u001b[0m", "").replace("\u202e", ""),
    );
    expect(text.stdout).not.toContain("\u001b");
  }));

test("список документов выводит краткую карточку с адресом и не печатает полный Markdown", () =>
  withCliFixture(async (cli) => {
    const project = cli.createProject();
    const body = "Полное скрытое содержание документа";
    const document = cli.withDatabase(project, (db) =>
      new KnowledgeService(db).create(
        "document",
        {
          name: "Краткая карточка",
          body,
        },
        "agent",
      ),
    );
    const text = await cli.invoke(["document", "list"]);
    expect(text).toMatchObject({ code: 0, stderr: "" });
    expect(text.stdout).toContain(document.key);
    expect(text.stdout).toContain("Краткая карточка");
    expect(text.stdout).not.toContain(body);
  }));
