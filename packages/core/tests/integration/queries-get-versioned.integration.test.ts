import { describe, expect, spyOn, test } from "bun:test";
import {
  RelayError,
  type CommandEntityVersions,
  type CommandLoadRequest,
  type CommandReadAnchor,
} from "@relay/contracts";
import { ProjectDatabase, portableAggregateVersion } from "@relay/storage";
import * as entityQueries from "../../../storage/src/entities/entity-queries";
import * as documentSections from "../../src/knowledge/document-sections";
import { KnowledgeService } from "../../src/knowledge/knowledge";
import { PlanningService } from "../../src/planning/planning";
import { QueryService } from "../../src/queries/queries";
import { TasksService } from "../../src/tasks/tasks";
import {
  entityWriteOptions as write,
  expectAsyncRelayError,
  withEntityDatabase,
} from "./helpers/entity-fixture";

const actor = "tester";
const views = [
  { name: "full", summary: false },
  { name: "summary", summary: true },
] as const;
const barriers = [
  { name: "full после identities", summary: false, selector: "identities" },
  { name: "summary после virtual", summary: true, selector: "virtual" },
] as const;

/**
 * Получает независимый эталон metadata из переносимого SQL-снимка, а не проверяемого command load.
 * Формулу непрозрачного aggregate token предоставляет Storage; Core её не воспроизводит.
 */
function snapshotVersions(
  db: ProjectDatabase,
  ids: readonly string[],
): Readonly<Record<string, CommandEntityVersions>> {
  const snapshot = db.captureReplication();
  return Object.fromEntries(
    ids.map((id) => {
      const entity = snapshot.entities.find((item) => item.record.id === id);
      if (entity === undefined || snapshot.components === undefined) {
        throw new Error(`В проверочном снимке отсутствует агрегат ${id}`);
      }
      return [
        id,
        {
          recordVersion: entity.version,
          aggregateVersion: portableAggregateVersion(entity, snapshot.components),
        },
      ];
    }),
  );
}

/**
 * Запрещает полное чтение там, где контракт обещает узкую summary-проекцию.
 */
function forbiddenFullRead(): never {
  throw new Error("Summary загрузила полную карточку или граф");
}

describe("Версионированное групповое чтение", () => {
  test("full сохраняет полные данные, алиасы, порядок, повторы и ошибки, версии содержат только успешные ID", async () => {
    await withEntityDatabase(async (db) => {
      const knowledge = new KnowledgeService(db);
      const initial = await knowledge.create(
        "document",
        {
          name: "Правила Ω",
          body: "# Полный Markdown\n\n  Отступ\n\n```ts\nconst n = 1;\n```\n",
        },
        actor,
      );
      const document = await knowledge.rename("document", initial.id, "RULES", write(initial));
      const tasks = new TasksService(db);
      const initialTask = await tasks.create(
        {
          title: "Задача",
          description: "Полное описание",
          acceptanceCriteria: [{ title: "Критерий", description: "Подробности критерия" }],
        },
        actor,
      );
      await tasks.comment(initialTask.id, "Сохранённый комментарий", actor);
      const task = tasks.get(initialTask.id);
      const planning = new PlanningService(db);
      const initialPlan = await planning.create(
        "work-plan",
        { title: "План", goal: "Цель" },
        actor,
      );
      const plan = await planning.stage(
        initialPlan.id,
        "create",
        { title: "Этап", outcome: "Результат" },
        write(initialPlan),
      );
      const refs = [
        plan.key,
        initial.key,
        `task:${task.id}`,
        "RULES",
        initial.key,
        "MISSING",
        `task:${document.id}`,
        "unknown:ID",
        " document ",
      ];
      const generation = db.getGeneration();
      const versions = snapshotVersions(db, [plan.id, document.id, task.id]);

      const result = await new QueryService(db).getManyVersioned(refs);

      expect(result.data.view).toBe("full");
      expect(result.data.generation).toBe(generation);
      expect(result.data.items.map((item) => item.ref)).toEqual(refs);
      expect(result.data.items.slice(0, 5)).toEqual([
        { ref: plan.key, ok: true, entity: plan },
        { ref: initial.key, ok: true, entity: document },
        { ref: `task:${task.id}`, ok: true, entity: task },
        { ref: "RULES", ok: true, entity: document },
        { ref: initial.key, ok: true, entity: document },
      ]);
      expect(result.data.items.slice(5)).toMatchObject([
        { ok: false, error: { code: "NOT_FOUND", exitCode: 3, details: { ref: "MISSING" } } },
        { ok: false, error: { code: "NOT_FOUND", details: { ref: document.id, kind: "task" } } },
        { ok: false, error: { code: "INVALID_ARGUMENT", exitCode: 2 } },
        { ok: false, error: { code: "VALIDATION_ERROR", exitCode: 2 } },
      ]);
      expect(result.versions).toEqual(versions);
      expect(Object.hasOwn(result.versions, db.projectId)).toBe(false);
      expect(db.getGeneration()).toBe(generation);
    });
  });

  test("typed и virtual сохраняют приоритет прямого адреса, ожидаемый вид и локальную неоднозначность", async () => {
    await withEntityDatabase(async (db) => {
      const knowledge = new KnowledgeService(db);
      const initial = await knowledge.create(
        "application",
        { name: "Клиент", slug: "client", prefix: "CLI" },
        actor,
      );
      const application = await knowledge.rename(
        "application",
        initial.id,
        "CLIENT",
        write(initial),
      );
      const board = knowledge.get("board", initial.data.boardId);
      const second = await knowledge.create(
        "application",
        { name: "Второе", slug: "second" },
        actor,
      );
      const feature = await knowledge.create(
        "feature",
        { name: "Прямой адрес другого вида" },
        actor,
      );
      const direct = await knowledge.rename("feature", feature.id, "CLI", write(feature));
      // Нарушаем уникальность virtual для проверки неоднозначности и приоритета буквального алиаса.
      db.update(
        {
          ...second,
          revision: second.revision + 1,
          data: { ...second.data, slug: "client", prefix: initial.key },
        },
        second.revision,
      );
      const refs = [
        `application:${initial.key}`,
        "application:CLI",
        "board:client",
        "board:CLI",
        "CLI",
        "application:client",
        "application:missing",
        "application:CLI",
        "client",
      ];
      const loads = spyOn(db.commands, "load");
      try {
        const result = await new QueryService(db).getManyVersioned(refs);

        expect(result.data.items.slice(0, 5)).toEqual([
          { ref: `application:${initial.key}`, ok: true, entity: application },
          { ref: "application:CLI", ok: true, entity: application },
          { ref: "board:client", ok: true, entity: board },
          { ref: "board:CLI", ok: true, entity: board },
          { ref: "CLI", ok: true, entity: direct },
        ]);
        expect(result.data.items.slice(5)).toMatchObject([
          {
            ok: false,
            error: { code: "CORRUPT_DATA", details: { ref: "client", kind: "application" } },
          },
          {
            ok: false,
            error: { code: "NOT_FOUND", details: { ref: "missing", kind: "application" } },
          },
          { ok: true, entity: application },
          { ok: false, error: { code: "NOT_FOUND", details: { ref: "client" } } },
        ]);
        expect(Object.keys(result.versions).sort()).toEqual(
          [application.id, board.id, direct.id].sort(),
        );
        const selectors = loads.mock.calls.flatMap(([request]) => request.selectors);
        expect(selectors.filter((selector) => selector.kind === "identities")).toEqual([
          { kind: "identities", refs: [initial.key, "CLI", "client", "missing"] },
        ]);
        expect(selectors.filter((selector) => selector.kind === "virtual")).toEqual([
          { kind: "virtual", ref: "CLI", entityKind: "application" },
          { kind: "virtual", ref: "client", entityKind: "board" },
          { kind: "virtual", ref: "CLI", entityKind: "board" },
          { kind: "virtual", ref: "client", entityKind: "application" },
          { kind: "virtual", ref: "missing", entityKind: "application" },
        ]);
      } finally {
        loads.mockRestore();
      }
    });
  });

  test("full проецирует снятый раздел в null, сохраняет raw источник и загружает один backing project", async () => {
    await withEntityDatabase(async (db) => {
      const knowledge = new KnowledgeService(db);
      const project = await knowledge.changeSection(
        "create",
        { id: "guides", name: "Руководства" },
        write(knowledge.get("project")),
      );
      const document = await knowledge.create(
        "document",
        { name: "Исторический раздел", body: "Текст", sectionId: "guides" },
        actor,
      );
      const second = await knowledge.create(
        "document",
        { name: "Второй документ", body: "Текст" },
        actor,
      );
      const damaged = await knowledge.create(
        "document",
        { name: "Неизвестный раздел", body: "Текст" },
        actor,
      );
      await knowledge.changeSection("remove", { id: "guides" }, write(project));
      db.update(
        {
          ...damaged,
          revision: damaged.revision + 1,
          data: { ...damaged.data, sectionId: "never-existed" },
        },
        damaged.revision,
      );
      const versions = snapshotVersions(db, [document.id, second.id]);
      const generation = db.getGeneration();
      const sections = spyOn(documentSections, "indexDocumentSections");
      const loads = spyOn(db.commands, "load");
      try {
        const result = await new QueryService(db).getManyVersioned([
          document.key,
          second.id,
          damaged.id,
          document.id,
        ]);

        expect(result.data.items).toMatchObject([
          { ok: true, entity: { ...document, data: { ...document.data, sectionId: null } } },
          { ok: true, entity: second },
          {
            ok: false,
            error: { code: "CORRUPT_DATA", details: { id: damaged.id, field: "sectionId" } },
          },
          { ok: true, entity: { ...document, data: { ...document.data, sectionId: null } } },
        ]);
        expect(result.versions).toEqual(versions);
        expect(result.data.generation).toBe(generation);
        expect(sections).toHaveBeenCalledTimes(1);
        expect(
          loads.mock.calls
            .flatMap(([request]) => request.selectors)
            .filter((selector) => selector.kind === "records"),
        ).toEqual([{ kind: "records", ids: [document.id, second.id, damaged.id, db.projectId] }]);
        expect(db.get(document.id)).toEqual(document);
        expect(db.getGeneration()).toBe(generation);
      } finally {
        sections.mockRestore();
        loads.mockRestore();
      }
    });
  });

  test("summary возвращает узкие карточки и metadata без полных записей, проекта, Markdown, критериев и комментариев", async () => {
    await withEntityDatabase(async (db) => {
      const document = await new KnowledgeService(db).create(
        "document",
        { name: "Правила", body: "НЕ-ЧИТАТЬ-ТЕЛО", summary: "НЕ-ЧИТАТЬ-АННОТАЦИЮ" },
        actor,
      );
      const tasks = new TasksService(db);
      const task = await tasks.create(
        {
          title: "Задача",
          description: "НЕ-ЧИТАТЬ-ОПИСАНИЕ",
          acceptanceCriteria: [{ title: "Критерий", description: "НЕ-ЧИТАТЬ-КРИТЕРИЙ" }],
        },
        actor,
      );
      await tasks.comment(task.id, "НЕ-ЧИТАТЬ-КОММЕНТАРИЙ", actor);
      const versions = snapshotVersions(db, [document.id, task.id]);
      const generation = db.getGeneration();
      const loads = spyOn(db.commands, "load");
      const single = spyOn(entityQueries, "getEntity").mockImplementation(forbiddenFullRead);
      const records = spyOn(entityQueries, "getEntities").mockImplementation(forbiddenFullRead);
      const list = spyOn(entityQueries, "listEntities").mockImplementation(forbiddenFullRead);
      const graph = spyOn(entityQueries, "taskGraphRecords").mockImplementation(forbiddenFullRead);
      const parsed: string[] = [];
      const parse = JSON.parse;
      const parsing = spyOn(JSON, "parse").mockImplementation((value, reviver) => {
        parsed.push(value);
        return parse(value, reviver);
      });
      try {
        const result = await new QueryService(db).getManyVersioned(
          [document.key, task.id, task.key, "MISSING"],
          { summary: true },
        );

        expect(result.data.view).toBe("summary");
        expect(result.data.generation).toBe(generation);
        expect(result.data.items.slice(0, 3)).toEqual([
          {
            ref: document.key,
            ok: true,
            entity: {
              id: document.id,
              key: document.key,
              kind: "document",
              revision: document.revision,
              title: "Правила",
              state: "draft",
            },
          },
          ...[task.id, task.key].map((ref) => ({
            ref,
            ok: true as const,
            entity: {
              id: task.id,
              key: task.key,
              kind: "task" as const,
              revision: task.revision,
              title: "Задача",
              state: "inbox" as const,
            },
          })),
        ]);
        expect(result.data.items[3]).toMatchObject({
          ref: "MISSING",
          ok: false,
          error: { code: "NOT_FOUND" },
        });
        expect(result.versions).toEqual(versions);
        expect(loads.mock.calls.flatMap(([request]) => request.selectors)).toEqual([
          { kind: "identities", refs: [document.key, task.id, task.key, "MISSING"] },
          { kind: "summaries", ids: [document.id, task.id] },
        ]);
        expect(parsed.some((value) => value.includes("НЕ-ЧИТАТЬ"))).toBe(false);
        expect(single).not.toHaveBeenCalled();
        expect(records).not.toHaveBeenCalled();
        expect(list).not.toHaveBeenCalled();
        expect(graph).not.toHaveBeenCalled();
      } finally {
        loads.mockRestore();
        single.mockRestore();
        records.mockRestore();
        list.mockRestore();
        graph.mockRestore();
        parsing.mockRestore();
      }
    });
  });

  test.each(views)(
    "$name оставляет повреждённый заголовок ошибкой элемента и исключает его metadata",
    async ({ summary }) => {
      await withEntityDatabase(async (db) => {
        const knowledge = new KnowledgeService(db);
        const damaged = await knowledge.create("feature", { name: "Будет повреждено" }, actor);
        const task = await new TasksService(db).create({ title: " \t " }, actor);
        db.update(
          { ...damaged, revision: damaged.revision + 1, data: { ...damaged.data, name: null } },
          damaged.revision,
        );
        const generation = db.getGeneration();

        const result = await new QueryService(db).getManyVersioned(
          [task.id, damaged.id, task.key, damaged.key],
          { summary },
        );

        expect(
          result.data.items.map((item) => (item.ok ? item.entity.id : item.error.code)),
        ).toEqual([task.id, "CORRUPT_DATA", task.id, "CORRUPT_DATA"]);
        expect(result.data.items[0]).toMatchObject({
          ok: true,
          entity: summary ? { title: " \t " } : { data: { title: " \t " } },
        });
        expect(result.data.items[1]).toMatchObject({
          ok: false,
          error: { exitCode: 1, details: { id: damaged.id } },
        });
        expect(result.versions).toEqual(snapshotVersions(db, [task.id]));
        expect(result.data.generation).toBe(generation);
        expect(db.get(damaged.id)?.data.name).toBeNull();
      });
    },
  );

  test("повреждение полного содержания не ломает соседей и не требует его проверки в summary", async () => {
    await withEntityDatabase(async (db) => {
      const knowledge = new KnowledgeService(db);
      const damaged = await knowledge.create(
        "document",
        { name: "Название сохранно", body: "Текст" },
        actor,
      );
      const other = await knowledge.create("feature", { name: "Соседняя карточка" }, actor);
      db.update(
        { ...damaged, revision: damaged.revision + 1, data: { ...damaged.data, relations: null } },
        damaged.revision,
      );
      const queries = new QueryService(db);

      const full = await queries.getManyVersioned([damaged.id, other.id]);
      const summary = await queries.getManyVersioned([damaged.id], { summary: true });

      expect(full.data.items).toMatchObject([
        { ok: false, error: { code: "CORRUPT_DATA", details: { id: damaged.id } } },
        { ok: true, entity: other },
      ]);
      expect(Object.keys(full.versions)).toEqual([other.id]);
      expect(summary.data.items).toMatchObject([
        { ok: true, entity: { id: damaged.id, title: "Название сохранно" } },
      ]);
      expect(summary.versions).toEqual(snapshotVersions(db, [damaged.id]));
    });
  });

  test.each(barriers)(
    "$name: чужой commit между loads отклоняет anchor вместо смешанного результата",
    async ({ summary, selector }) => {
      await withEntityDatabase(async (db) => {
        const document = await new KnowledgeService(db).create(
          "document",
          { name: "До commit", body: "Старый текст" },
          actor,
        );
        const writer = ProjectDatabase.open(db.path);
        const ready = Promise.withResolvers<void>();
        const resume = Promise.withResolvers<void>();
        const requests: CommandLoadRequest[] = [];
        let anchor: CommandReadAnchor | undefined;
        const original = db.commands.load.bind(db.commands);
        const loads = spyOn(db.commands, "load").mockImplementation(async (request) => {
          requests.push(request);
          const loaded = await original(request);
          anchor ??= loaded.anchor;
          if (request.selectors.some((item) => item.kind === selector)) {
            ready.resolve();
            await resume.promise;
          }
          return loaded;
        });
        const reading = new QueryService(db).getManyVersioned([document.id, "board:product"], {
          summary,
        });
        const failure = expectAsyncRelayError(() => reading, "COMMAND_CONTEXT_CHANGED");
        try {
          await ready.promise;
          const changed = await new KnowledgeService(writer).update(
            "document",
            document.id,
            { name: "После commit", body: "Новый текст" },
            write(document),
          );
          resume.resolve();

          const error = await failure;

          expect(error.exitCode).toBe(4);
          if (anchor === undefined) {
            throw new Error("Начальный load не вернул anchor");
          }
          expect(error.details).toMatchObject({ expected: anchor });
          expect(requests[0]?.anchor).toBeNull();
          for (const request of requests.slice(1)) {
            expect(request.anchor).toBe(anchor);
          }
          expect(db.get(document.id)).toEqual(changed);
        } finally {
          resume.resolve();
          await Promise.allSettled([reading, failure]);
          loads.mockRestore();
          writer.close();
        }
      });
    },
  );

  test("неверная форма запроса отклоняется до первого I/O", async () => {
    await withEntityDatabase(async (db) => {
      const loads = spyOn(db.commands, "load");
      const queries = new QueryService(db);
      const unknownOptions = { summary: true, unexpected: true };
      try {
        await expectAsyncRelayError(() => queries.getManyVersioned([]), "INVALID_ARGUMENT");
        await expectAsyncRelayError(
          () => queries.getManyVersioned(Array.from({ length: 201 }, () => "PROJECT")),
          "INVALID_ARGUMENT",
        );
        await expectAsyncRelayError(
          () => queries.getManyVersioned(["PROJECT"], unknownOptions),
          "INVALID_ARGUMENT",
        );

        expect(loads).not.toHaveBeenCalled();
      } finally {
        loads.mockRestore();
      }
    });
  });

  test.each(views)(
    "$name возвращает реальное поколение даже для одних ошибочных адресов",
    async ({ summary }) => {
      await withEntityDatabase(async (db) => {
        await new KnowledgeService(db).create("feature", { name: "Поколение существует" }, actor);
        const generation = db.getGeneration();

        const result = await new QueryService(db).getManyVersioned(
          ["unknown:ID", " ", "task:MISSING"],
          { summary },
        );

        expect(generation).toBeGreaterThan(0);
        expect(result.data.generation).toBe(generation);
        expect(
          result.data.items.map((item) => (item.ok ? item.entity.id : item.error.code)),
        ).toEqual(["INVALID_ARGUMENT", "VALIDATION_ERROR", "NOT_FOUND"]);
        expect(result.versions).toEqual({});
      });
    },
  );

  test("инфраструктурный отказ command port прерывает Promise, а не становится ошибкой адреса", async () => {
    await withEntityDatabase(async (db) => {
      const failure = new RelayError("STORAGE_ERROR", "Отказ соединения", 1);
      const loads = spyOn(db.commands, "load").mockRejectedValueOnce(failure);
      try {
        const error = await expectAsyncRelayError(
          () => new QueryService(db).getManyVersioned(["PROJECT"]),
          "STORAGE_ERROR",
        );

        expect(error).toBe(failure);
      } finally {
        loads.mockRestore();
      }
    });
  });
});
