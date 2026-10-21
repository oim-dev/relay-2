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
  test("название фичи находится без учёта регистра", () => {
    withEntityDatabase((db) => {
      const feature = new KnowledgeService(db).create(
        "feature",
        { name: "Яркое название", description: "Требование шага" },
        actor,
      );
      const queries = new QueryService(db);

      const result = queries.search({ q: "ЯРКОЕ" });

      expect(result).toEqual([feature]);
    });
  });

  test("описание критерия включено в поиск задачи", () => {
    withEntityDatabase((db) => {
      const task = new TasksService(db).create(
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

  test("полный Markdown документа включён в поиск", () => {
    withEntityDatabase((db) => {
      const document = new KnowledgeService(db).create(
        "document",
        { name: "Документ", body: "Глубокий Markdown\n\n    содержание" },
        actor,
      );
      const queries = new QueryService(db);

      const result = queries.search({ q: "Глубокий Markdown" });

      expect(result).toEqual([document]);
    });
  });

  test("пояснение связи включено в поиск документа", () => {
    withEntityDatabase((db) => {
      const knowledge = new KnowledgeService(db);
      const feature = knowledge.create("feature", { name: "Цель" }, actor);
      const document = knowledge.create("document", { name: "Документ", body: "Текст" }, actor);
      const linked = knowledge.linkDocument(document.id, feature.id, {
        ...write(document),
        description: "Уникальное-основание",
      });
      const queries = new QueryService(db);

      const result = queries.search({ q: "Уникальное-основание" });

      expect(result).toEqual([linked]);
    });
  });

  test("ожидаемый итог этапа включён в поиск плана", () => {
    withEntityDatabase((db) => {
      const planning = new PlanningService(db);
      const plan = planning.create("work-plan", { title: "План", goal: "Результат" }, actor);
      const staged = planning.stage(
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

  test("журнал комментариев не включён в поиск содержания задачи", () => {
    withEntityDatabase((db) => {
      const tasks = new TasksService(db);
      const task = tasks.create({ title: "Работа" }, actor);
      tasks.comment(task.id, "Секретный-комментарий", actor);
      const queries = new QueryService(db);

      const result = queries.search({ q: "Секретный-комментарий" });

      expect(result).toEqual([]);
    });
  });

  test.each(excludedMetadata)("$name не включается в поиск содержания", ({ source }) => {
    withEntityDatabase((db) => {
      const feature = new KnowledgeService(db).create("feature", { name: "Фича" }, actor);
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

  test("фильтр вида исключает текстовое совпадение другой области", () => {
    withEntityDatabase((db) => {
      new KnowledgeService(db).create("feature", { name: "Яркое название" }, actor);
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
  test.each(referenceForms)("$name после переименования находит ту же фичу", ({ field, typed }) => {
    withEntityDatabase((db) => {
      const knowledge = new KnowledgeService(db);
      const initial = knowledge.create(
        "feature",
        { name: "Поиск", description: "Описание" },
        actor,
      );
      const renamed = knowledge.rename("feature", initial.id, "FIND", write(initial));
      const address = field === "alias" ? initial.key : renamed[field];
      const ref = typed ? `feature:${address}` : address;
      const queries = new QueryService(db);

      const exact = queries.get(ref);
      const found = queries.search({ q: ref });

      expect(exact).toEqual(renamed);
      expect(found).toEqual([renamed]);
    });
  });

  test("фильтр вида исключает точное совпадение алиаса чужой области", () => {
    withEntityDatabase((db) => {
      const knowledge = new KnowledgeService(db);
      const feature = knowledge.create("feature", { name: "Поиск" }, actor);
      knowledge.rename("feature", feature.id, "FIND", write(feature));
      const queries = new QueryService(db);

      const result = queries.search({ q: feature.key, kind: "task" });

      expect(result).toEqual([]);
    });
  });

  test("часть старого алиаса не считается точным адресом", () => {
    withEntityDatabase((db) => {
      const knowledge = new KnowledgeService(db);
      const feature = knowledge.create("feature", { name: "Поиск" }, actor);
      knowledge.rename("feature", feature.id, "FIND", write(feature));
      const queries = new QueryService(db);

      const result = queries.search({ q: "FEATURE-" });

      expect(result).toEqual([]);
    });
  });

  test("типизированная ссылка чужого вида даёт NOT_FOUND", () => {
    withEntityDatabase((db) => {
      const feature = new KnowledgeService(db).create("feature", { name: "Поиск" }, actor);
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
  test("обзор включает весь состав и считает блокировку незавершённой зависимостью", () => {
    withEntityDatabase((db) => {
      const tasks = new TasksService(db);
      const blocker = tasks.create({ title: "Блокер" }, actor);
      const dependent = tasks.create(
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

  test("status возвращает полный счётчик и поколение без чтения списка карточек", () => {
    withEntityDatabase((db) => {
      new TasksService(db).create({ title: "Работа" }, actor);
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

  test("commit другого соединения между чтениями не меняет поколение и состав обзора", () => {
    withEntityDatabase((db) => {
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
          new TasksService(writer).create({ title: "После начала снимка" }, actor);
        }
        return records;
      });
      try {
        const overview = queries.overview();

        expect(written).toBe(true);
        expect(overview.generation).toBe(generation);
        expect(overview.items).toHaveLength(3);
        expect(overview.counts.task).toBe(0);
        expect(overview.tasks.total).toBe(0);
      } finally {
        list.mockRestore();
        writer.close();
      }
      expect(queries.overview().counts.task).toBe(1);
      expect(db.getGeneration()).toBeGreaterThan(generation);
    });
  });
});

describe("Диагностика целостности проекта", () => {
  test("валидный проект возвращает проверенный состав и пустой список нарушений", () => {
    withEntityDatabase((db) => {
      const tasks = new TasksService(db);
      const blocker = tasks.create({ title: "Блокер" }, actor);
      tasks.create({ title: "Зависимая", dependencies: [blocker.id] }, actor);
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

  test("сочетание пропавшей цели, неверного вида и цикла возвращает все нарушения без записи", () => {
    withEntityDatabase((db) => {
      const tasks = new TasksService(db);
      const first = tasks.create({ title: "Первая" }, actor);
      const second = tasks.create({ title: "Вторая", dependencies: [first.id] }, actor);
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
    ({ operation, code }) => {
      withEntityDatabase((db) => {
        const document = new KnowledgeService(db).create(
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
    ({ retired }) => {
      withEntityDatabase((db) => {
        const knowledge = new KnowledgeService(db);
        const project = knowledge.changeSection(
          "create",
          { id: "guides", name: "Руководства" },
          write(knowledge.get("project")),
        );
        const first = knowledge.create(
          "document",
          { name: "Первый", body: "Первое руководство", sectionId: "guides" },
          actor,
        );
        knowledge.create(
          "document",
          { name: "Второй", body: "Второе руководство", sectionId: "guides" },
          actor,
        );
        if (retired) {
          knowledge.changeSection("remove", { id: "guides" }, write(project));
        }
        const snapshot = db.list();
        const generation = db.getGeneration();
        const queries = new QueryService(db);
        const reads = spyOn(db, "get");
        try {
          const result = queries.check();

          expect(result).toEqual({
            projectId: db.projectId,
            generation,
            valid: true,
            records: 5,
            issues: [],
          });
          expect(reads.mock.calls.filter(([ref]) => ref === db.projectId)).toHaveLength(1);
        } finally {
          reads.mockRestore();
        }
        expect(knowledge.get("document", first.id).data.sectionId).toBe(retired ? null : "guides");
        expect(db.list()).toEqual(snapshot);
        expect(db.getGeneration()).toBe(generation);
      });
    },
  );

  test("неизвестный раздел диагностируется, а легально удалённый сохраняется без записи", () => {
    withEntityDatabase((db) => {
      const knowledge = new KnowledgeService(db);
      const project = knowledge.changeSection(
        "create",
        { id: "guides", name: "Руководства" },
        write(knowledge.get("project")),
      );
      const first = knowledge.create(
        "document",
        { name: "Первый", body: "Текст", sectionId: "guides" },
        actor,
      );
      const second = knowledge.create(
        "document",
        { name: "Второй", body: "Текст", sectionId: "guides" },
        actor,
      );
      knowledge.changeSection("remove", { id: "guides" }, write(project));
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

  test("get не маскирует неизвестный раздел как удалённый", () => {
    withEntityDatabase((db) => {
      const document = new KnowledgeService(db).create(
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

  test("валидные реализации и история принимаются doctor вместе с остальными областями", () => {
    withEntityDatabase((db) => {
      const knowledge = new KnowledgeService(db);
      const feature = knowledge.create("feature", { name: "Фича" }, actor);
      const application = knowledge.create("application", { name: "Web", slug: "web" }, actor);
      knowledge.replaceParticipation(application.id, [feature.id], write(application));
      const history = new HistoryService(db);
      const session = history.start({ title: "Поручение" }, actor);
      history.checkpoint(
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
