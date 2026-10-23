import { describe, expect, spyOn, test } from "bun:test";
import { KnowledgeService, PlanningService, QueryService, TasksService } from "@relay/core";
import { runCli } from "../../src/app/run";
import { withCliFixture } from "./helpers/cli-fixture";
import { arrayValue, objectValue, readEntitiesValue } from "./helpers/responses";

const partialFailures = [
  {
    name: "отсутствующий адрес перед неверным видом",
    first: { ref: "missing", code: "NOT_FOUND", exitCode: 3 },
    second: { ref: "unknown-kind:x", code: "INVALID_ARGUMENT", exitCode: 2 },
  },
  {
    name: "неверный вид перед отсутствующим адресом",
    first: { ref: "unknown-kind:x", code: "INVALID_ARGUMENT", exitCode: 2 },
    second: { ref: "missing", code: "NOT_FOUND", exitCode: 3 },
  },
] as const;

describe("Групповое чтение через CLI", () => {
  test("get --format=json -- PROJECT читает полный паспорт из rest без позиционных refs", async () => {
    await withCliFixture(async (cli) => {
      const project = cli.createProject();
      const expected = cli.withDatabase(project, (db) => new KnowledgeService(db).get("project"));

      const response = await cli.invoke(["get", "--format=json", "--", expected.key]);

      expect(response).toMatchObject({ code: 0, stderr: "" });
      expect(JSON.parse(response.stdout)).toMatchObject({
        ok: true,
        data: { view: "full", items: [{ ref: expected.key, ok: true, entity: expected }] },
      });
    }, "get-batch/cli-review");
  });

  test("ключи с дефисом и флаги после -- остаются адресами с исходным порядком и повторами", async () => {
    await withCliFixture(async (cli) => {
      const project = cli.createProject();
      const document = cli.withDatabase(project, (db) => {
        const knowledge = new KnowledgeService(db);
        let document = knowledge.create(
          "document",
          { name: "Буквальные адреса", body: "# Полное содержание\n" },
          "fixture",
        );
        for (const key of ["-RULES", "--summary", "--format=json"]) {
          document = knowledge.rename("document", document.id, key, {
            actor: "fixture",
            ifRevision: document.revision,
          });
        }
        return document;
      });
      const rest = ["-RULES", "--summary", "DOC-1", "--format=json"];

      const response = await cli.invoke(["get", "DOC-1", "--format=json", "--", ...rest]);
      const text = await cli.invoke(["get", "--", "-RULES"]);

      expect(response).toMatchObject({ code: 0, stderr: "" });
      expect(JSON.parse(response.stdout)).toMatchObject({
        ok: true,
        data: {
          view: "full",
          items: ["DOC-1", ...rest].map((ref) => ({ ref, ok: true, entity: document })),
        },
      });
      expect(text).toMatchObject({ code: 0, stderr: "" });
      expect(text.stdout).toContain('GET 1 НАЧАЛО · адрес "-RULES"');
      expect(text.stdout).toContain(`# Полное содержание\n`);
      expect(text.stdout).toContain(`ID: ${document.id}`);
    }, "get-batch/cli-review");
  });

  test("закрытый stdout не скрывает код и диагностику ошибки адреса", async () => {
    await withCliFixture(async (cli) => {
      cli.createProject();
      let stderr = "";

      const code = await runCli(
        ["get", "missing", "--format", "json"],
        {
          /**
           * Закрытый pipe не должен подменять предметный отказ успешным завершением.
           */
          stdout: (): never => {
            throw Object.assign(new Error("Закрыт pipe"), { code: "EPIPE" });
          },
          /**
           * Сохраняет независимую диагностику адресного чтения.
           */
          stderr: (text): void => {
            stderr += text;
          },
        },
        cli.runtime,
      );

      expect(code).toBe(3);
      expect(JSON.parse(stderr)).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
    }, "get-batch");
  });

  test("смешанный полный набор сохраняет порядок, повторы и точное содержание", async () => {
    await withCliFixture(async (cli) => {
      const project = cli.createProject();
      const markdown = "\n# Правила\n\n    пример\n\n";
      const records = cli.withDatabase(
        project,
        (db) =>
          [
            new KnowledgeService(db).create(
              "document",
              { name: "Документ", body: markdown },
              "fixture",
            ),
            new TasksService(db).create({ title: "Задача", description: markdown }, "fixture"),
            new PlanningService(db).create(
              "work-plan",
              { title: "План", summary: markdown },
              "fixture",
            ),
          ] as const,
      );
      const refs = [...records.map((record) => record.key), records[0].id];

      const response = await cli.success(["get", ...refs]);
      const entities = readEntitiesValue(response.data);

      expect(
        arrayValue(objectValue(response.data).items).map((item) => objectValue(item).ref),
      ).toEqual(refs);
      expect(entities).toEqual([...records, records[0]]);
      expect(entities[0]?.data.body).toBe(markdown);
    }, "get-batch");
  });

  test("--summary передаётся Core и исключает тела, критерии и журналы из text и JSON", async () => {
    await withCliFixture(async (cli) => {
      const project = cli.createProject();
      const task = cli.withDatabase(project, (db) => {
        const tasks = new TasksService(db);
        const task = tasks.create(
          {
            title: "Краткая задача",
            description: "НЕ_ВЫВОДИТЬ_ОПИСАНИЕ",
            acceptanceCriteria: [{ title: "НЕ_ВЫВОДИТЬ_КРИТЕРИЙ" }],
          },
          "fixture",
        );
        tasks.comment(task.id, "НЕ_ВЫВОДИТЬ_КОММЕНТАРИЙ", "fixture");
        return task;
      });

      const response = await cli.success(["get", task.key, "--summary"]);
      const text = await cli.invoke(["get", task.key, "--summary"]);

      expect(objectValue(response.data)).toEqual({
        view: "summary",
        generation: cli.withDatabase(project, (db) => db.getGeneration()),
        items: [
          {
            ref: task.key,
            ok: true,
            entity: {
              id: task.id,
              key: task.key,
              kind: "task",
              revision: task.revision,
              title: "Краткая задача",
              state: "inbox",
            },
          },
        ],
      });
      expect(text).toMatchObject({ code: 0, stderr: "" });
      expect(text.stdout).toContain(`${task.key} [task] · ID ${task.id}`);
      expect(text.stdout).not.toContain("НЕ_ВЫВОДИТЬ");
      expect(text.stdout).not.toContain("Критерии");
      expect(text.stdout).not.toContain("Комментарии");
    }, "get-batch");
  });

  test.each(partialFailures)(
    "$name: частичный JSON сохраняет элементы и код первой ошибки",
    async ({ first, second }) => {
      await withCliFixture(async (cli) => {
        const project = cli.createProject();
        const document = cli.withDatabase(project, (db) =>
          new KnowledgeService(db).create(
            "document",
            { name: "Найденный", body: "Полный текст" },
            "fixture",
          ),
        );

        const response = await cli.invoke([
          "get",
          first.ref,
          document.key,
          second.ref,
          document.key,
          "--format",
          "json",
        ]);

        expect(response.code).toBe(first.exitCode);
        const envelope = objectValue(JSON.parse(response.stdout));
        expect(envelope.ok).toBe(false);
        expect(objectValue(envelope.error).code).toBe(first.code);
        const data = objectValue(envelope.data);
        expect(data.view).toBe("full");
        const items = arrayValue(data.items).map(objectValue);
        expect(items.map((item) => item.ref)).toEqual([
          first.ref,
          document.key,
          second.ref,
          document.key,
        ]);
        expect(items[0]).toMatchObject({
          ok: false,
          error: { code: first.code, exitCode: first.exitCode },
        });
        expect(items[1]).toMatchObject({ ok: true, entity: document });
        expect(items[2]).toMatchObject({
          ok: false,
          error: { code: second.code, exitCode: second.exitCode },
        });
        expect(items[3]).toEqual(items[1]);
        expect(JSON.parse(response.stderr)).toMatchObject({
          ok: false,
          error: { code: first.code },
        });
        expect(response.stdout.trim().split("\n")).toHaveLength(1);
        const missing = items.find((item) => item.ref === "missing");
        expect(missing).toMatchObject({ error: { details: { ref: "missing" } } });
      }, "get-batch");
    },
  );

  test("частичный текст показывает успешную запись и ошибочный блок без сокрытия", async () => {
    await withCliFixture(async (cli) => {
      const project = cli.createProject();
      const document = cli.withDatabase(project, (db) =>
        new KnowledgeService(db).create(
          "document",
          { name: "Найденный", body: "# Сохранённый текст\n" },
          "fixture",
        ),
      );

      const response = await cli.invoke(["get", document.key, "missing"]);

      expect(response.code).toBe(3);
      expect(response.stdout).toContain("# Сохранённый текст\n");
      expect(response.stdout).toContain(`ID: ${document.id}`);
      expect(response.stdout).toContain(
        '\n\n=== GET 2 НАЧАЛО · адрес "missing" ===\nОшибка [NOT_FOUND]:',
      );
      expect(response.stdout).not.toContain("GET 2 КОНЕЦ");
      expect(response.stderr).toContain("NOT_FOUND");
    }, "get-batch");
  });

  test("200 повторов допускаются, 201 отклоняется без частичного результата", async () => {
    await withCliFixture(async (cli) => {
      const project = cli.createProject();
      const key = cli.withDatabase(project, (db) => new KnowledgeService(db).get("project").key);

      const response = await cli.success([
        "get",
        ...Array.from({ length: 200 }, () => key),
        "--summary",
      ]);
      const error = await cli.error(["get", ...Array.from({ length: 201 }, () => key)], 2);

      expect(arrayValue(objectValue(response.data).items)).toHaveLength(200);
      expect(error.code).toBe("INVALID_ARGUMENT");
    }, "get-batch");
  });

  test("неожиданная инфраструктурная ошибка не объявляется частичным ответом", async () => {
    await withCliFixture(async (cli) => {
      cli.createProject();
      const read = spyOn(QueryService.prototype, "getMany").mockImplementation(() => {
        throw new Error("Чтение прервано");
      });
      try {
        const error = await cli.error(["get", "DOC-1"], 1);

        expect(error.code).toBe("INTERNAL_ERROR");
        expect(error.message).toBe("Чтение прервано");
      } finally {
        read.mockRestore();
      }
    }, "get-batch");
  });

  test("параллельный успешный get не стирает частичный отказ соседнего runCli", async () => {
    await withCliFixture(async (cli) => {
      const project = cli.createProject();
      const document = cli.withDatabase(project, (db) =>
        new KnowledgeService(db).create("document", { name: "Документ", body: "Текст" }, "fixture"),
      );

      const [partial, successful] = await Promise.all([
        cli.invoke(["get", "missing", document.key, "--format=json"]),
        cli.invoke(["get", document.key, "--format=json"]),
      ]);

      expect(partial.code).toBe(3);
      expect(JSON.parse(partial.stderr)).toMatchObject({ error: { code: "NOT_FOUND" } });
      expect(JSON.parse(partial.stdout)).toMatchObject({
        ok: false,
        data: {
          items: [
            { ref: "missing", ok: false, error: { code: "NOT_FOUND" } },
            { ref: document.key, ok: true, entity: document },
          ],
        },
      });
      expect(successful).toMatchObject({ code: 0, stderr: "" });
      expect(JSON.parse(successful.stdout)).toMatchObject({
        ok: true,
        data: { view: "full", items: [{ ref: document.key, ok: true, entity: document }] },
      });
    }, "get-batch");
  });
});
