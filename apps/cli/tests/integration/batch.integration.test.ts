import { describe, expect, spyOn, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { KnowledgeService } from "@relay/core";
import { ProjectDatabase } from "@relay/storage";
import { runCli } from "../../src/app/run";
import { withCliFixture } from "./helpers/cli-fixture";
import { arrayValue, objectValue } from "./helpers/responses";

const inputSources = ["inline", "file", "stdin"] as const;
const markdown = '\n# Новая редакция\n\n  Сохраняем пробелы\n{"$ref":"буквальный-текст"}\n';

describe("Атомарный пакет через CLI", () => {
  test.each(inputSources)("%s: --input передаёт JSON и точный Markdown в Core", async (source) => {
    await withCliFixture(async (cli) => {
      const project = cli.createProject();
      const input = JSON.stringify({
        version: 1,
        operations: [
          {
            op: "document.create",
            as: "doc",
            input: { name: "Правила", body: markdown, pinned: false },
          },
        ],
      });
      writeFileSync(join(cli.runtime.cwd, "изменения с пробелами.json"), input);
      const value = { inline: input, file: "@изменения с пробелами.json", stdin: "-" }[source];
      const stdinLimits: (number | undefined)[] = [];
      const openedBeforeInput: number[] = [];
      let openedConnections = 0;
      const open = spyOn(ProjectDatabase, "open");
      const close = spyOn(ProjectDatabase.prototype, "close");
      try {
        const response = await cli.success(
          [
            "batch",
            "--input",
            value,
            "--operation-key",
            "source",
            "--actor",
            "explicit-author",
            "--return",
            "full",
          ],
          {
            /**
             * Проверяет передачу потокового лимита и отсутствие открытия БД до завершения ввода.
             * Микрозадача оставляет stdin незавершённым без временных задержек; другие источники его не читают.
             */
            stdin: async (maxBytes): Promise<string> => {
              stdinLimits.push(maxBytes);
              await Promise.resolve();
              openedBeforeInput.push(open.mock.calls.length);
              return input;
            },
          },
        );

        expect(stdinLimits).toEqual(source === "stdin" ? [8 * 1024 * 1024] : []);
        expect(openedBeforeInput).toEqual(source === "stdin" ? [0] : []);
        const data = objectValue(response.data);
        expect(data).toMatchObject({
          operationKey: "source",
          status: "committed",
          replayed: false,
        });
        expect(arrayValue(data.items)).toHaveLength(1);
        expect(arrayValue(data.entities)).toHaveLength(1);
        expect(arrayValue(data.entities)[0]).toMatchObject({
          kind: "document",
          createdBy: "explicit-author",
          data: { body: markdown, pinned: false },
        });
        openedConnections = open.mock.calls.length;
        expect(close).toHaveBeenCalledTimes(1);
      } finally {
        open.mockRestore();
        close.mockRestore();
      }
      expect(
        cli.withDatabase(project, (db) => new KnowledgeService(db).list("document")[0]?.data.body),
      ).toBe(markdown);
      expect(openedConnections).toBe(1);
    }, "get-batch/cli-open-project");
  });

  test("смешанный create/update передаёт ревизии и восстанавливает исходную квитанцию после новых запусков", async () => {
    await withCliFixture(async (cli) => {
      const project = cli.createProject();
      const original = cli.withDatabase(project, (db) =>
        new KnowledgeService(db).create(
          "document",
          { name: "Старая редакция", body: "Исходный текст", documentStatus: "active" },
          "fixture",
        ),
      );
      const input = JSON.stringify({
        version: 1,
        operations: [
          { op: "document.create", as: "new", input: { name: "Новая редакция", body: markdown } },
          {
            op: "document.update",
            as: "published",
            ref: { $ref: "new" },
            ifRevision: { $revision: "new" },
            input: { documentStatus: "active" },
          },
          {
            op: "document.update",
            ref: original.key,
            ifRevision: original.revision,
            input: { documentStatus: "archived" },
          },
        ],
      });
      const args = ["batch", "--input", input, "--operation-key", "publish"];

      const committed = objectValue((await cli.success(args)).data);
      const replay = objectValue((await cli.success([...args, "--return", "full"])).data);
      const stored = objectValue(
        (
          await cli.success(["batch", "result", "publish", "--return", "full"], {
            env: { ...cli.runtime.env, RELAY_ACTOR: undefined },
          })
        ).data,
      );

      expect(committed).toMatchObject({
        operationKey: "publish",
        status: "committed",
        replayed: false,
      });
      expect(committed).not.toHaveProperty("entities");
      const items = arrayValue(committed.items).map(objectValue);
      expect(items).toHaveLength(3);
      expect(items.map((item) => item.op)).toEqual([
        "document.create",
        "document.update",
        "document.update",
      ]);
      expect(items[0]).toMatchObject({ index: 0, as: "new", kind: "document", revision: 1 });
      expect(items[1]).toMatchObject({ index: 1, as: "published", id: items[0]?.id, revision: 2 });
      expect(items[2]).toMatchObject({ id: original.id, revision: original.revision + 1 });
      expect(replay).toMatchObject({ ...committed, replayed: true });
      expect(stored).toEqual(replay);
      expect(stored.entities).toMatchObject([
        {
          id: items[0]?.id,
          kind: "document",
          revision: 2,
          data: { name: "Новая редакция", body: markdown, documentStatus: "active" },
        },
        {
          id: original.id,
          kind: "document",
          revision: original.revision + 1,
          data: { name: "Старая редакция", body: "Исходный текст", documentStatus: "archived" },
        },
      ]);
      const compactText = await cli.invoke(["batch", "result", "publish"]);
      const fullText = await cli.invoke(["batch", "result", "publish", "--return", "full"]);
      expect(compactText).toMatchObject({ code: 0, stderr: "" });
      expect(compactText.stdout).toContain("Ключ операции: publish");
      expect(compactText.stdout).toContain("Операция: document.create");
      expect(compactText.stdout).not.toContain(markdown);
      expect(compactText.stdout).not.toContain("Итоговые сущности");
      expect(fullText).toMatchObject({ code: 0, stderr: "" });
      expect(fullText.stdout).toContain(markdown);
      expect(
        cli.withDatabase(project, (db) => new KnowledgeService(db).list("document")),
      ).toHaveLength(2);

      cli.withDatabase(project, (db) =>
        new KnowledgeService(db).update(
          "document",
          original.id,
          { body: "Позднее изменение" },
          { actor: "fixture", ifRevision: original.revision + 1 },
        ),
      );
      const afterChange = objectValue(
        (await cli.success(["batch", "result", "publish", "--return", "full"])).data,
      );
      expect(afterChange).toEqual(stored);
    }, "get-batch");
  });

  test("--check работает с автором без ключа и откатывает результат до последующего применения", async () => {
    await withCliFixture(async (cli) => {
      const project = cli.createProject();
      const generation = cli.withDatabase(project, (db) => db.getGeneration());
      const input = JSON.stringify({
        version: 1,
        operations: [{ op: "document.create", input: { name: "Проверка", body: markdown } }],
      });

      const checked = objectValue(
        (await cli.success(["batch", "--check", "--input", input, "--return", "full"])).data,
      );

      expect(checked).toMatchObject({ operationKey: null, status: "checked", replayed: false });
      expect(arrayValue(checked.entities)[0]).toMatchObject({
        key: "DOC-1",
        data: { body: markdown },
      });
      expect(cli.withDatabase(project, (db) => db.getGeneration())).toBe(generation);
      expect(cli.withDatabase(project, (db) => new KnowledgeService(db).list("document"))).toEqual(
        [],
      );

      const applied = objectValue(
        (await cli.success(["batch", "--input", input, "--operation-key", "after-check"])).data,
      );
      expect(applied.status).toBe("committed");
      expect(arrayValue(applied.items)[0]).toMatchObject({ key: "DOC-1" });
    }, "get-batch");
  });

  test("устаревшая числовая ifRevision сохраняет REVISION_CONFLICT и не подменяется свежей", async () => {
    await withCliFixture(async (cli) => {
      const project = cli.createProject();
      const document = cli.withDatabase(project, (db) => {
        const knowledge = new KnowledgeService(db);
        const initial = knowledge.create("document", { name: "Правила", body: "Было" }, "fixture");
        return knowledge.update(
          "document",
          initial.id,
          { body: "Актуально" },
          { actor: "fixture", ifRevision: initial.revision },
        );
      });
      const input = JSON.stringify({
        version: 1,
        operations: [
          {
            op: "document.update",
            ref: document.key,
            ifRevision: document.revision - 1,
            input: { body: "Устарело" },
          },
        ],
      });

      const error = await cli.error(["batch", "--input", input, "--operation-key", "stale"], 4);

      expect(error.code).toBe("REVISION_CONFLICT");
      expect(error.details).toMatchObject({ index: 0, op: "document.update" });
      expect(
        cli.withDatabase(project, (db) => new KnowledgeService(db).get("document", document.id)),
      ).toEqual(document);
    }, "get-batch");
  });

  test("содержимое @файла разбирается один раз и не выбирает другой источник", async () => {
    await withCliFixture(async (cli) => {
      writeFileSync(join(cli.runtime.cwd, "literal.json"), '"@missing.json"');

      const error = await cli.error(["batch", "--check", "--input", "@literal.json"], 2);

      expect(error.code).toBe("INVALID_JSON");
    }, "get-batch");
  });

  test("ошибка stdout после commit сохраняет квитанцию для восстановления", async () => {
    await withCliFixture(async (cli) => {
      const project = cli.createProject();
      const input = JSON.stringify({
        version: 1,
        operations: [{ op: "document.create", input: { name: "Сохранённый", body: markdown } }],
      });
      let stderr = "";

      const code = await runCli(
        ["batch", "--input", input, "--operation-key", "lost-output", "--format", "json"],
        {
          /**
           * Воспроизводит отказ канала результата после завершённого commit.
           */
          stdout: (): never => {
            throw Object.assign(new Error("Канал недоступен"), { code: "EIO" });
          },
          /**
           * Захватывает диагностику вывода независимо от сохранённых данных.
           */
          stderr: (text): void => {
            stderr += text;
          },
        },
        cli.runtime,
      );
      const restored = objectValue(
        (await cli.success(["batch", "result", "lost-output", "--return", "full"])).data,
      );

      expect(code).toBe(1);
      expect(JSON.parse(stderr)).toMatchObject({
        ok: false,
        error: { code: "INTERNAL_ERROR", message: "Канал недоступен" },
      });
      expect(restored).toMatchObject({
        operationKey: "lost-output",
        status: "committed",
        replayed: true,
      });
      expect(arrayValue(restored.entities)[0]).toMatchObject({ data: { body: markdown } });
      expect(
        cli.withDatabase(project, (db) => new KnowledgeService(db).list("document")),
      ).toHaveLength(1);
    }, "get-batch");
  });

  test("файл более 8 МиБ отклоняется до открытия выбранной БД", async () => {
    await withCliFixture(async (cli) => {
      writeFileSync(join(cli.runtime.cwd, "oversized.json"), "я".repeat(4 * 1024 * 1024 + 1));
      const open = spyOn(ProjectDatabase, "open");
      try {
        const error = await cli.error(["batch", "--check", "--input", "@oversized.json"], 2);

        expect(error.code).toBe("INPUT_TOO_LARGE");
        expect(open).not.toHaveBeenCalled();
      } finally {
        open.mockRestore();
      }
    }, "get-batch");
  });

  test("байт FF внутри JSON файла отклоняется до открытия БД без исправления тела", async () => {
    await withCliFixture(async (cli) => {
      const bytes = Buffer.concat([
        Buffer.from(
          '{"version":1,"operations":[{"op":"document.create","input":{"name":"Повреждённый UTF-8","body":"A',
        ),
        new Uint8Array([0xff]),
        Buffer.from('B"}}]}'),
      ]);
      writeFileSync(join(cli.runtime.cwd, "invalid-utf8.json"), bytes);
      const open = spyOn(ProjectDatabase, "open");
      try {
        const error = await cli.error(
          ["batch", "--input", "@invalid-utf8.json", "--operation-key", "invalid-utf8"],
          2,
        );

        expect(error.code).toBe("INVALID_UTF8");
        expect(open).not.toHaveBeenCalled();
      } finally {
        open.mockRestore();
      }
    }, "get-batch/cli-review");
  });
});
