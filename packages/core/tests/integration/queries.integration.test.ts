import { describe, expect, spyOn, test } from "bun:test";
import type { EntityKind, EntityRecord, WriteOptions } from "@relay/contracts";
import { ProjectDatabase } from "@relay/storage";
import { HistoryService } from "../../src/history/history";
import { KnowledgeService } from "../../src/knowledge/knowledge";
import { PlanningService } from "../../src/planning/planning";
import { QueryService } from "../../src/queries/queries";
import { TasksService } from "../../src/tasks/tasks";
import { entityWriteOptions, expectRelayError, withEntityDatabase } from "./helpers/entity-fixture";

const actor = "автор-не-для-поиска";
const invalidSearches = [
  { name: "пустой запрос", input: { q: "", kind: "task" } },
  { name: "неизвестное поле", input: { q: "Работа", unexpected: true } },
] as const;
const referenceForms = [
  { name: "ID", field: "id", typed: false },
  { name: "алиас", field: "alias", typed: false },
  { name: "ключ", field: "key", typed: false },
  { name: "типизированный ID", field: "id", typed: true },
  { name: "типизированный алиас", field: "alias", typed: true },
  { name: "типизированный ключ", field: "key", typed: true },
] as const;
const excludedMetadata = [
  { name: "автор", source: "actor" },
  { name: "имя технического поля", source: "field" },
  { name: "дата создания", source: "date" },
] as const;
const corruptedReads = [
  { operation: "get", code: "CORRUPT_DATA" },
  { operation: "search", code: "CORRUPT_DATA" },
  { operation: "overview", code: "CORRUPT_DATA" },
  { operation: "check", code: "INTEGRITY_ERROR" },
] as const;
const sectionStates = [
  { name: "активные", retired: false },
  { name: "удалённые", retired: true },
] as const;

/**
 * Передаёт ревизию подготовленного снимка и технического автора поиска без перечитывания БД.
 */
function write(entity: EntityRecord): WriteOptions {
  return entityWriteOptions(entity, actor);
}

describe("Предметные тексты поиска", () => {
  test("название фичи находится без учёта регистра", async () => {
    await withEntityDatabase(async (db) => {
      const feature = await new KnowledgeService(db).create(
        "feature",
        { name: "Яркое название", description: "Требование шага" },
        actor,
      );
      const queries = new QueryService(db);

      const result = queries.search({ q: "ЯРКОЕ" });

      expect(result).toEqual([feature]);
    });
  });

  test("описание критерия включено в поиск задачи", async () => {
    await withEntityDatabase(async (db) => {
      const task = await new TasksService(db).create(
        {
          title: "Работа",
          acceptanceCriteria: [{ title: "Критерий", description: "Уникальный-критерий" }],
        },
        actor,
      );
      const queries = new QueryService(db);

      const result = queries.search({ q: "уникальный-критерий" });

      expect(result).toEqual([task]);
    });
  });

  test("полный Markdown документа включён в поиск", async () => {
    await withEntityDatabase(async (db) => {
      const document = await new KnowledgeService(db).create(
        "document",
        { name: "Документ", body: "Глубокий Markdown\n\n    содержание" },
        actor,
      );
      const queries = new QueryService(db);

      const result = queries.search({ q: "Глубокий Markdown" });

      expect(result).toEqual([document]);
    });
  });

  test("пояснение связи включено в поиск документа", async () => {
    await withEntityDatabase(async (db) => {
      const knowledge = new KnowledgeService(db);
      const feature = await knowledge.create("feature", { name: "Цель" }, actor);
      const document = await knowledge.create(
        "document",
        { name: "Документ", body: "Текст" },
        actor,
      );
      const linked = await knowledge.linkDocument(document.id, feature.id, {
        ...write(document),
        description: "Уникальное-основание",
      });
      const queries = new QueryService(db);

      const result = queries.search({ q: "Уникальное-основание" });

      expect(result).toEqual([linked]);
    });
  });

  test("ожидаемый итог этапа включён в поиск плана", async () => {
    await withEntityDatabase(async (db) => {
      const planning = new PlanningService(db);
      const plan = await planning.create("work-plan", { title: "План", goal: "Результат" }, actor);
      const staged = await planning.stage(
        plan.id,
        "create",
        { title: "Этап", outcome: "Уникальный-итог" },
        write(plan),
      );
      const queries = new QueryService(db);

      const result = queries.search({ q: "Уникальный-итог" });

      expect(result).toEqual([staged]);
    });
  });

  test("журнал комментариев не включён в поиск содержания задачи", async () => {
    await withEntityDatabase(async (db) => {
      const tasks = new TasksService(db);
      const task = await tasks.create({ title: "Работа" }, actor);
      await tasks.comment(task.id, "Секретный-комментарий", actor);
      const queries = new QueryService(db);

      const result = queries.search({ q: "Секретный-комментарий" });

      expect(result).toEqual([]);
    });
  });

  test.each(excludedMetadata)("$name не включается в поиск содержания", async ({ source }) => {
    await withEntityDatabase(async (db) => {
      const feature = await new KnowledgeService(db).create("feature", { name: "Фича" }, actor);
      let q = actor;
      if (source === "field") {
        q = "createdAt";
      } else if (source === "date") {
        q = feature.createdAt;
      }
      const queries = new QueryService(db);

      const result = queries.search({ q });

      expect(result).toEqual([]);
    });
  });

  test("фильтр вида исключает текстовое совпадение другой области", async () => {
    await withEntityDatabase(async (db) => {
      await new KnowledgeService(db).create("feature", { name: "Яркое название" }, actor);
      const queries = new QueryService(db);

      const result = queries.search({ q: "Яркое", kind: "document" });

      expect(result).toEqual([]);
    });
  });

  test.each(invalidSearches)("$name отклоняется с INVALID_ARGUMENT", ({ input }) => {
    withEntityDatabase((db) => {
      const queries = new QueryService(db);

      expectRelayError(() => queries.search(input), "INVALID_ARGUMENT");
    });
  });
});

describe("Адреса в get и поиске", () => {
  test.each(referenceForms)(
    "$name после переименования находит ту же фичу",
    async ({ field, typed }) => {
      await withEntityDatabase(async (db) => {
        const knowledge = new KnowledgeService(db);
        const initial = await knowledge.create(
          "feature",
          { name: "Поиск", description: "Описание" },
          actor,
        );
        const renamed = await knowledge.rename("feature", initial.id, "FIND", write(initial));
        const address = field === "alias" ? initial.key : renamed[field];
        const ref = typed ? `feature:${address}` : address;
        const queries = new QueryService(db);

        const exact = queries.get(ref);
        const found = queries.search({ q: ref });

        expect(exact).toEqual(renamed);
        expect(found).toEqual([renamed]);
      });
    },
  );

  test("фильтр вида исключает точное совпадение алиаса чужой области", async () => {
    await withEntityDatabase(async (db) => {
      const knowledge = new KnowledgeService(db);
      const feature = await knowledge.create("feature", { name: "Поиск" }, actor);
      await knowledge.rename("feature", feature.id, "FIND", write(feature));
      const queries = new QueryService(db);

      const result = queries.search({ q: feature.key, kind: "task" });

      expect(result).toEqual([]);
    });
  });

  test("часть старого алиаса не считается точным адресом", async () => {
    await withEntityDatabase(async (db) => {
      const knowledge = new KnowledgeService(db);
      const feature = await knowledge.create("feature", { name: "Поиск" }, actor);
      await knowledge.rename("feature", feature.id, "FIND", write(feature));
      const queries = new QueryService(db);

      const result = queries.search({ q: "FEATURE-" });

      expect(result).toEqual([]);
    });
  });

  test("типизированная ссылка чужого вида даёт NOT_FOUND", async () => {
    await withEntityDatabase(async (db) => {
      const feature = await new KnowledgeService(db).create("feature", { name: "Поиск" }, actor);
      const queries = new QueryService(db);

      expectRelayError(() => queries.get(`task:${feature.id}`), "NOT_FOUND");
    });
  });

  test("неизвестный вид в ссылке даёт INVALID_ARGUMENT", () => {
    withEntityDatabase((db) => {
      const queries = new QueryService(db);

      expectRelayError(() => queries.get("unsupported:KEY"), "INVALID_ARGUMENT");
    });
  });
});

describe("Обзор и стоимость status", () => {
  test("обзор включает весь состав и считает блокировку незавершённой зависимостью", async () => {
    await withEntityDatabase(async (db) => {
      const tasks = new TasksService(db);
      const blocker = await tasks.create({ title: "Блокер" }, actor);
      const dependent = await tasks.create(
        { title: "Зависимая", column: "ready", dependencies: [blocker.id] },
        actor,
      );
      const queries = new QueryService(db);

      const overview = queries.overview();

      expect(overview.project.id).toBe(db.projectId);
      expect(overview.items).toHaveLength(5);
      expect(overview.items).toEqual(expect.arrayContaining([blocker, dependent]));
      expect(overview.counts.task).toBe(2);
      expect(overview.tasks).toMatchObject({
        total: 2,
        blocked: 1,
        columns: { inbox: 1, ready: 1, done: 0 },
      });
    });
  });

  test("status возвращает полный счётчик и поколение без чтения списка карточек", async () => {
    await withEntityDatabase(async (db) => {
      await new TasksService(db).create({ title: "Работа" }, actor);
      const generation = db.getGeneration();
      const queries = new QueryService(db);
      const fullRead = spyOn(db, "list");
      try {
        const status = queries.status();

        expect(status).toMatchObject({
          projectId: db.projectId,
          databasePath: db.path,
          generation,
          records: 4,
        });
        expect(status.bytes).toBeGreaterThan(0);
        expect(fullRead).not.toHaveBeenCalled();
      } finally {
        fullRead.mockRestore();
      }
    });
  });

  test("commit другого соединения между чтениями не меняет поколение и состав обзора", async () => {
    await withEntityDatabase(async (db) => {
      const initialTask = await new TasksService(db).create({ title: "До начала снимка" }, actor);
      const addedTask = {
        ...initialTask,
        id: crypto.randomUUID(),
        key: "PRODUCT-2",
        data: { ...initialTask.data, title: "После начала снимка" },
      };
      const queries = new QueryService(db);
      const writer = ProjectDatabase.open(db.path);
      /**
       * Сохраняет настоящий метод чтения, чтобы перехват не рекурсировал в spy.
       */
      const originalList: (kind?: EntityKind) => EntityRecord[] = db.list.bind(db);
      const generation = db.getGeneration();
      let written = false;
      const list = spyOn(db, "list").mockImplementation((kind) => {
        const records = originalList(kind);
        if (!written) {
          // Commit попадает строго между чтением состава и остальных частей обзора.
          written = true;
          writer.transaction(() => writer.insert(addedTask));
        }
        return records;
      });
      try {
        const overview = queries.overview();

        expect(written).toBe(true);
        expect(overview.generation).toBe(generation);
        expect(overview.items).toHaveLength(4);
        expect(overview.items.filter((record) => record.kind === "task")).toEqual([initialTask]);
        expect(overview.counts.task).toBe(1);
        expect(overview.tasks.total).toBe(1);
      } finally {
        list.mockRestore();
        writer.close();
      }
      expect(queries.overview().items.filter((record) => record.kind === "task")).toEqual([
        initialTask,
        addedTask,
      ]);
      expect(queries.overview().counts.task).toBe(2);
      expect(db.getGeneration()).toBeGreaterThan(generation);
    });
  });
});

describe("Диагностика целостности проекта", () => {
  test("валидный проект возвращает проверенный состав и пустой список нарушений", async () => {
    await withEntityDatabase(async (db) => {
      const tasks = new TasksService(db);
      const blocker = await tasks.create({ title: "Блокер" }, actor);
      await tasks.create({ title: "Зависимая", dependencies: [blocker.id] }, actor);
      const generation = db.getGeneration();
      const queries = new QueryService(db);

      const result = queries.check();

      expect(result).toEqual({
        projectId: db.projectId,
        generation,
        valid: true,
        records: 5,
        issues: [],
      });
    });
  });

  test("сочетание пропавшей цели, неверного вида и цикла возвращает все нарушения без записи", async () => {
    await withEntityDatabase(async (db) => {
      const tasks = new TasksService(db);
      const first = await tasks.create({ title: "Первая" }, actor);
      const second = await tasks.create({ title: "Вторая", dependencies: [first.id] }, actor);
      // Намеренно повреждаем несколько связей через Storage: doctor должен собрать их вместе.
      db.update(
        {
          ...first,
          revision: first.revision + 1,
          data: {
            ...first.data,
            boardId: second.id,
            dependencies: [second.id],
            targets: ["missing-id"],
          },
        },
        first.revision,
      );
      const snapshot = db.list();
      const generation = db.getGeneration();
      const queries = new QueryService(db);

      const error = expectRelayError(() => queries.check(), "INTEGRITY_ERROR");

      expect(error.exitCode).toBe(1);
      expect(error.details).toMatchObject({
        valid: false,
        issues: expect.arrayContaining([
          expect.stringContaining("missing-id"),
          expect.stringContaining("тип ссылки"),
          expect.stringContaining("TASK_CYCLE"),
        ]),
      });
      expect(db.list()).toEqual(snapshot);
      expect(db.getGeneration()).toBe(generation);
    });
  });

  test.each(corruptedReads)(
    "$operation отклоняет повреждённые отношения без изменения документа",
    async ({ operation, code }) => {
      await withEntityDatabase(async (db) => {
        const document = await new KnowledgeService(db).create(
          "document",
          { name: "Документ", body: "Содержание" },
          actor,
        );
        // Намеренное повреждение вне предметного API: null не означает отсутствие связей.
        const corruptedRecord = {
          ...document,
          revision: document.revision + 1,
          data: { ...document.data, relations: null },
        };
        db.update(corruptedRecord, document.revision);
        const generation = db.getGeneration();
        const queries = new QueryService(db);

        const error = expectRelayError(() => {
          switch (operation) {
            case "get":
              return queries.get(document.id);
            case "search":
              return queries.search({ q: "Документ" });
            case "overview":
              return queries.overview();
            case "check":
              return queries.check();
          }
        }, code);

        if (operation === "check") {
          expect(error.message).toContain(document.key);
        }
        expect(db.get(document.id)).toEqual(corruptedRecord);
        expect(db.getGeneration()).toBe(generation);
      });
    },
  );

  test.each(sectionStates)(
    "$name разделы проверяются одним общим индексом без записи",
    async ({ retired }) => {
      await withEntityDatabase(async (db) => {
        const knowledge = new KnowledgeService(db);
        const project = await knowledge.changeSection(
          "create",
          { id: "guides", name: "Руководства" },
          write(knowledge.get("project")),
        );
        const first = await knowledge.create(
          "document",
          { name: "Первый", body: "Первое руководство", sectionId: "guides" },
          actor,
        );
        await knowledge.create(
          "document",
          { name: "Второй", body: "Второе руководство", sectionId: "guides" },
          actor,
        );
        if (retired) {
          await knowledge.changeSection("remove", { id: "guides" }, write(project));
        }
        const snapshot = db.list();
        const generation = db.getGeneration();
        const queries = new QueryService(db);
        const reads = spyOn(db, "get");
        const identities = spyOn(db, "getIdentity");
        const lists = spyOn(db, "list");
        try {
          const result = queries.check();

          expect(result).toEqual({
            projectId: db.projectId,
            generation,
            valid: true,
            records: 5,
            issues: [],
          });
          expect(reads).not.toHaveBeenCalled();
          expect(identities).not.toHaveBeenCalled();
          expect(lists).toHaveBeenCalledTimes(1);
        } finally {
          reads.mockRestore();
          identities.mockRestore();
          lists.mockRestore();
        }
        expect(knowledge.get("document", first.id).data.sectionId).toBe(retired ? null : "guides");
        expect(db.list()).toEqual(snapshot);
        expect(db.getGeneration()).toBe(generation);
      });
    },
  );

  test("неизвестный раздел диагностируется, а легально удалённый сохраняется без записи", async () => {
    await withEntityDatabase(async (db) => {
      const knowledge = new KnowledgeService(db);
      const project = await knowledge.changeSection(
        "create",
        { id: "guides", name: "Руководства" },
        write(knowledge.get("project")),
      );
      const first = await knowledge.create(
        "document",
        { name: "Первый", body: "Текст", sectionId: "guides" },
        actor,
      );
      const second = await knowledge.create(
        "document",
        { name: "Второй", body: "Текст", sectionId: "guides" },
        actor,
      );
      await knowledge.changeSection("remove", { id: "guides" }, write(project));
      // Этот ID никогда не был зарегистрирован, в отличие от раздела первого документа.
      const corruptedRecord = {
        ...second,
        revision: second.revision + 1,
        data: { ...second.data, sectionId: "never-existed" },
      };
      db.update(corruptedRecord, second.revision);
      const generation = db.getGeneration();
      const queries = new QueryService(db);

      const error = expectRelayError(() => queries.check(), "INTEGRITY_ERROR");

      expect(error.message).toContain(second.key);
      expect(db.get(second.id)).toEqual(corruptedRecord);
      expect(db.get(first.id)).toEqual(first);
      expect(db.getGeneration()).toBe(generation);
    });
  });

  test("get не маскирует неизвестный раздел как удалённый", async () => {
    await withEntityDatabase(async (db) => {
      const document = await new KnowledgeService(db).create(
        "document",
        { name: "Документ", body: "Текст" },
        actor,
      );
      // Намеренное повреждение ссылки на раздел через Storage.
      db.update(
        {
          ...document,
          revision: document.revision + 1,
          data: { ...document.data, sectionId: "never-existed" },
        },
        document.revision,
      );
      const queries = new QueryService(db);

      expectRelayError(() => queries.get(document.id), "CORRUPT_DATA");
    });
  });

  test("валидные реализации и история принимаются doctor вместе с остальными областями", async () => {
    await withEntityDatabase(async (db) => {
      const knowledge = new KnowledgeService(db);
      const feature = await knowledge.create("feature", { name: "Фича" }, actor);
      const application = await knowledge.create(
        "application",
        { name: "Web", slug: "web" },
        actor,
      );
      await knowledge.replaceParticipation(application.id, [feature.id], write(application));
      const history = new HistoryService(db);
      const session = await history.start({ title: "Поручение" }, actor);
      await history.checkpoint(
        session.id,
        "open",
        { title: "Намерение", body: "Материал", runId: session.data.currentRunId },
        write(session),
      );
      const generation = db.getGeneration();
      const queries = new QueryService(db);

      const result = queries.check();

      expect(result).toEqual({
        projectId: db.projectId,
        generation,
        valid: true,
        records: 9,
        issues: [],
      });
    });
  });

  test("второй паспорт продукта отклоняется doctor без изменения записей", () => {
    withEntityDatabase((db) => {
      const product = new KnowledgeService(db).get("product");
      // Намеренно нарушаем уникальность singleton через Storage, недоступную в KnowledgeService.
      db.insert({ ...product, id: crypto.randomUUID(), key: "PRODUCT-EXTRA" });
      const snapshot = db.list();
      const generation = db.getGeneration();
      const queries = new QueryService(db);

      const error = expectRelayError(() => queries.check(), "INTEGRITY_ERROR");

      expect(error.message).toContain("единственный паспорт");
      expect(db.list()).toEqual(snapshot);
      expect(db.getGeneration()).toBe(generation);
    });
  });
});
