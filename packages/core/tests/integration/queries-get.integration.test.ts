import { describe, expect, spyOn, test } from "bun:test";
import { RelayError, type EntityRecord, type EntitySummary } from "@relay/contracts";
import { HistoryService } from "../../src/history/history";
import { KnowledgeService } from "../../src/knowledge/knowledge";
import { PlanningService } from "../../src/planning/planning";
import { QueryService } from "../../src/queries/queries";
import { TasksService } from "../../src/tasks/tasks";
import {
  entityWriteOptions as write,
  expectRelayError,
  withEntityDatabase,
} from "./helpers/entity-fixture";

const actor = "tester";
const views = [
  { name: "полное", summary: false },
  { name: "краткое", summary: true },
] as const;

/**
 * Берёт только идентичность подготовленной записи для независимого эталона краткой карточки.
 * Название и состояние каждого вида тест задаёт явно, без вызова проверяемой проекции.
 */
function summaryIdentity<T extends EntityRecord>(
  record: T,
): Pick<T, "id" | "kind" | "key" | "revision"> {
  return { id: record.id, kind: record.kind, key: record.key, revision: record.revision };
}

describe("Групповое предметное чтение", () => {
  test("документ, задача и план возвращаются полностью в порядке аргументов с повторами", async () => {
    await withEntityDatabase(async (db) => {
      const knowledge = new KnowledgeService(db);
      const initial = await knowledge.create(
        "document",
        {
          name: "Правила Ω",
          body: "# Полный Markdown\n\n  Строка с отступом\n\n```ts\nconst n = 1;\n```\n",
        },
        actor,
      );
      const document = await knowledge.rename("document", initial.id, "RULES", write(initial));
      const tasks = new TasksService(db);
      const initialTask = await tasks.create(
        {
          title: "Проверка",
          description: "Подробности задачи",
          acceptanceCriteria: [{ title: "Критерий", description: "Полный критерий" }],
        },
        actor,
      );
      await tasks.comment(initialTask.id, "Полный комментарий", actor);
      const task = tasks.get(initialTask.id);
      const planning = new PlanningService(db);
      const initialPlan = await planning.create(
        "work-plan",
        { title: "План", goal: "Подробная цель" },
        actor,
      );
      const plan = await planning.stage(
        initialPlan.id,
        "create",
        { title: "Этап", outcome: "Итог этапа" },
        write(initialPlan),
      );
      const generation = db.getGeneration();
      const refs = [plan.key, initial.key, `task:${task.id}`, "RULES", initial.key];

      const result = new QueryService(db).getMany(refs);

      expect(result).toEqual({
        view: "full",
        generation,
        items: [
          { ref: plan.key, ok: true, entity: plan },
          { ref: initial.key, ok: true, entity: document },
          { ref: `task:${task.id}`, ok: true, entity: task },
          { ref: "RULES", ok: true, entity: document },
          { ref: initial.key, ok: true, entity: document },
        ],
      });
    });
  });

  test.each(views)(
    "$name чтение сохраняет ошибки адресов между успешными элементами",
    async ({ summary }) => {
      await withEntityDatabase(async (db) => {
        const document = await new KnowledgeService(db).create(
          "document",
          { name: "Правила", body: "Текст" },
          actor,
        );
        const refs = [
          "unknown:ID",
          document.id,
          "MISSING",
          `task:${document.key}`,
          " document ",
          "MISSING",
        ];

        const result = new QueryService(db).getMany(refs, { summary });

        expect(result.items.map((item) => item.ref)).toEqual(refs);
        expect(result.items.map((item) => (item.ok ? item.entity.id : item.error.code))).toEqual([
          "INVALID_ARGUMENT",
          document.id,
          "NOT_FOUND",
          "NOT_FOUND",
          "VALIDATION_ERROR",
          "NOT_FOUND",
        ]);
        expect(result.items[0]).toMatchObject({
          ok: false,
          error: { exitCode: 2, message: expect.any(String) },
        });
        expect(result.items[2]).toEqual({
          ref: "MISSING",
          ok: false,
          error: {
            code: "NOT_FOUND",
            exitCode: 3,
            message: expect.any(String),
            details: { ref: "MISSING" },
          },
        });
        expect(result.items[3]).toMatchObject({
          error: { details: { ref: document.key, kind: "task" } },
        });
      });
    },
  );

  test("общий resolver сохраняет typed алиасы и виртуальные адреса приложений и досок", async () => {
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
      const refs = [
        `application:${initial.key}`,
        "application:client",
        "application:CLI",
        "board:client",
        "board:CLI",
      ];

      const result = new QueryService(db).getMany(refs);

      expect(result.items).toEqual([
        ...refs.slice(0, 3).map((ref) => ({ ref, ok: true as const, entity: application })),
        ...refs.slice(3).map((ref) => ({ ref, ok: true as const, entity: board })),
      ]);
    });
  });

  test("неоднозначный виртуальный адрес остаётся ошибкой только своего элемента", async () => {
    await withEntityDatabase(async (db) => {
      const knowledge = new KnowledgeService(db);
      const first = await knowledge.create("application", { name: "Первое", slug: "first" }, actor);
      const second = await knowledge.create(
        "application",
        { name: "Второе", slug: "second" },
        actor,
      );
      // Низкоуровневая запись нарушает уникальность виртуальных адресов, которую защищает Core.
      db.update(
        { ...second, revision: second.revision + 1, data: { ...second.data, slug: "first" } },
        second.revision,
      );

      const result = new QueryService(db).getMany(["application:first", first.id]);

      expect(result.items).toEqual([
        {
          ref: "application:first",
          ok: false,
          error: {
            code: "CORRUPT_DATA",
            exitCode: 1,
            message: expect.any(String),
            details: { ref: "first", kind: "application" },
          },
        },
        { ref: first.id, ok: true, entity: first },
      ]);
    });
  });

  test("удалённый раздел проецируется в null, неизвестный сохраняет CORRUPT_DATA без записи", async () => {
    await withEntityDatabase(async (db) => {
      const knowledge = new KnowledgeService(db);
      const project = await knowledge.changeSection(
        "create",
        { id: "guides", name: "Руководства" },
        write(knowledge.get("project")),
      );
      const document = await knowledge.create(
        "document",
        { name: "Документ", body: "Текст", sectionId: "guides" },
        actor,
      );
      const damaged = await knowledge.create(
        "document",
        { name: "Повреждённый", body: "Текст" },
        actor,
      );
      await knowledge.changeSection("remove", { id: "guides" }, write(project));
      const corrupted = {
        ...damaged,
        revision: damaged.revision + 1,
        data: { ...damaged.data, sectionId: "never-existed" },
      };
      db.update(corrupted, damaged.revision);
      const generation = db.getGeneration();
      const queries = new QueryService(db);

      const result = queries.getMany([document.id, damaged.key]);
      const single = queries.get(document.id);

      const projected = { ...document, data: { ...document.data, sectionId: null } };
      expect(result.items).toEqual([
        { ref: document.id, ok: true, entity: projected },
        {
          ref: damaged.key,
          ok: false,
          error: {
            code: "CORRUPT_DATA",
            exitCode: 1,
            message: expect.any(String),
            details: { id: damaged.id, field: "sectionId" },
          },
        },
      ]);
      expect(single).toEqual(projected);
      expect(knowledge.get("document", document.id)).toEqual(projected);
      expect(db.get(document.id)).toEqual(document);
      expect(db.get(damaged.id)).toEqual(corrupted);
      expect(db.getGeneration()).toBe(generation);
    });
  });

  test("краткие карточки сохраняют состояния видов и активность без вложенного содержания", async () => {
    await withEntityDatabase(async (db) => {
      const knowledge = new KnowledgeService(db);
      const feature = await knowledge.create("feature", { name: "Функциональность" }, actor);
      const application = await knowledge.create(
        "application",
        { name: "Клиент", slug: "client" },
        actor,
      );
      const implementation = await knowledge.create(
        "implementation",
        {
          application: application.id,
          target: feature.id,
          title: "Реализация",
          status: "partial",
        },
        actor,
      );
      const removed = await knowledge.replaceParticipation(
        application.id,
        [],
        write(knowledge.get("application", application.id)),
      );
      expect(removed.data.implementationIds).toEqual([]);
      const inactive = knowledge.get("implementation", implementation.id);
      const document = await knowledge.create(
        "document",
        { name: "Правила", body: "Текст", documentStatus: "active" },
        actor,
      );
      const task = await new TasksService(db).create({ title: "Задача", column: "ready" }, actor);
      const planning = new PlanningService(db);
      const plan = await planning.create("work-plan", { title: "План" }, actor);
      const release = await planning.create(
        "release",
        { title: "Выпуск", version: "1.0", planIds: [plan.id] },
        actor,
      );
      const session = await new HistoryService(db).start({ title: "Работа" }, actor);
      const product = knowledge.get("product");
      const records = [document, task, plan, release, session, inactive, feature, product];
      const expected: EntitySummary[] = [
        { ...summaryIdentity(document), title: "Правила", state: "active" },
        { ...summaryIdentity(task), title: "Задача", state: "ready" },
        { ...summaryIdentity(plan), title: "План", state: "draft" },
        { ...summaryIdentity(release), title: "Выпуск", state: "planned" },
        { ...summaryIdentity(session), title: "Работа", state: "open" },
        { ...summaryIdentity(inactive), title: "Реализация", state: "partial", active: false },
        { ...summaryIdentity(feature), title: "Функциональность" },
        { ...summaryIdentity(product), title: "PRODUCT" },
      ];

      const result = new QueryService(db).getMany(
        records.map((record) => record.id),
        { summary: true },
      );

      expect(result.view).toBe("summary");
      expect(result.items).toEqual(
        expected.map((entity) => ({ ref: entity.id, ok: true as const, entity })),
      );
    });
  });

  test.each(views)(
    "$name чтение не превращает инфраструктурный отказ в ошибочный элемент",
    ({ summary }) => {
      withEntityDatabase((db) => {
        const fault = new RelayError("STORAGE_ERROR", "Отказ соединения", 1);
        const identity = spyOn(db, "getIdentity").mockImplementation(() => {
          throw fault;
        });
        try {
          expect(() => new QueryService(db).getMany(["feature:FEATURE-1"], { summary })).toThrow(
            fault,
          );
        } finally {
          identity.mockRestore();
        }
      });
    },
  );

  test("summary сохраняет повреждённый выбранный заголовок как ошибку между найденными карточками", async () => {
    await withEntityDatabase(async (db) => {
      const knowledge = new KnowledgeService(db);
      const feature = await knowledge.create("feature", { name: "Повреждённая" }, actor);
      const document = await knowledge.create(
        "document",
        { name: "Правила", body: "Текст" },
        actor,
      );
      db.update(
        { ...feature, revision: feature.revision + 1, data: { ...feature.data, name: null } },
        feature.revision,
      );

      const result = new QueryService(db).getMany([document.id, feature.key, document.key], {
        summary: true,
      });

      expect(result.items.map((item) => (item.ok ? item.entity.id : item.error.code))).toEqual([
        document.id,
        "CORRUPT_DATA",
        document.id,
      ]);
      expect(result.items[1]).toMatchObject({
        ref: feature.key,
        ok: false,
        error: { exitCode: 1, details: { id: feature.id, kind: "feature", field: "title" } },
      });
    });
  });

  test("неверное число адресов отклоняется до открытия снимка", () => {
    withEntityDatabase((db) => {
      const snapshot = spyOn(db, "snapshot");
      try {
        expectRelayError(() => new QueryService(db).getMany([]), "INVALID_ARGUMENT");
        expectRelayError(
          () => new QueryService(db).getMany(Array.from({ length: 201 }, () => "PROJECT")),
          "INVALID_ARGUMENT",
        );
        expect(snapshot).not.toHaveBeenCalled();
      } finally {
        snapshot.mockRestore();
      }
    });
  });
});
