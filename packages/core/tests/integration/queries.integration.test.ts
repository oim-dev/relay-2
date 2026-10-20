import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { RelayError, type EntityRecord } from "@relay/contracts";
import { ProjectDatabase } from "@relay/storage";
import { EntityService } from "../../src/entities";
import { HistoryService } from "../../src/history";
import { KnowledgeService } from "../../src/knowledge";
import { PlanningService } from "../../src/planning";
import { QueryService } from "../../src/queries";
import { TasksService } from "../../src/tasks";

let directory: string;
let db: ProjectDatabase;
let queries: QueryService;
let entities: EntityService;
let knowledge: KnowledgeService;
let tasks: TasksService;
const actor = "автор-не-для-поиска";
const write = (entity: EntityRecord) => ({ actor, ifRevision: entity.revision });

beforeEach(() => {
  const artifacts = resolve(
    import.meta.dir,
    "../../../../.artifacts",
    new Date().toISOString().slice(0, 10),
  );
  mkdirSync(artifacts, { recursive: true });
  directory = mkdtempSync(join(artifacts, "queries-integration-"));
  db = ProjectDatabase.create(join(directory, "project.sqlite"), {
    id: crypto.randomUUID(),
    name: "Запросы",
    slug: "queries",
  });
  queries = new QueryService(db);
  entities = new EntityService(db);
  knowledge = new KnowledgeService(db);
  tasks = new TasksService(db);
});
afterEach(() => {
  db.close();
  rmSync(directory, { recursive: true, force: true });
});

function failure(operation: () => unknown, code: string): RelayError {
  try {
    operation();
    throw new Error(`Ожидалась ошибка ${code}`);
  } catch (error) {
    expect(error).toBeInstanceOf(RelayError);
    expect((error as RelayError).code).toBe(code);
    return error as RelayError;
  }
}

describe("QueryService с настоящей SQLite", () => {
  test("поиск читает предметные тексты, включая критерии, этапы и пояснения связей", () => {
    const feature = knowledge.create(
      "feature",
      { name: "Яркое название", description: "Требование шага" },
      actor,
    );
    const task = tasks.create(
      {
        title: "Работа",
        acceptanceCriteria: [{ title: "Критерий", description: "Уникальный-критерий" }],
      },
      actor,
    );
    tasks.comment(task.id, "Секретный-комментарий", actor);
    const document = knowledge.create(
      "document",
      { name: "Документ", body: "Глубокий Markdown\n\n    содержание" },
      actor,
    );
    knowledge.linkDocument(document.id, feature.id, {
      ...write(document),
      description: "Уникальное-основание",
    });
    const planning = new PlanningService(db);
    const plan = planning.create("work-plan", { title: "План", goal: "Результат" }, actor);
    planning.stage(plan.id, "create", { title: "Этап", outcome: "Уникальный-итог" }, write(plan));

    for (const [q, expected] of [
      ["ЯРКОЕ", feature.id],
      ["уникальный-критерий", task.id],
      ["Глубокий Markdown", document.id],
      ["Уникальное-основание", document.id],
      ["Уникальный-итог", plan.id],
    ]) {
      expect(queries.search({ q }).map((item) => item.id)).toEqual([expected!]);
    }
    for (const q of [actor, "Секретный-комментарий", "createdAt", feature.createdAt])
      expect(queries.search({ q })).toEqual([]);
    expect(queries.search({ q: "Яркое", kind: "document" })).toEqual([]);
    failure(() => queries.search({ q: "", kind: "task" }), "INVALID_ARGUMENT");
    failure(() => queries.search({ q: "Работа", unexpected: true }), "INVALID_ARGUMENT");
  });

  test("точные алиасы и типизированные ссылки разрешаются общим EntityService", () => {
    const feature = knowledge.create("feature", { name: "Поиск", description: "Описание" }, actor);
    const renamed = knowledge.rename("feature", feature.id, "FIND", write(feature));
    for (const ref of [
      feature.id,
      feature.key,
      renamed.key,
      `feature:${feature.id}`,
      `feature:${feature.key}`,
      `feature:${renamed.key}`,
    ]) {
      expect(queries.get(ref).id).toBe(feature.id);
      expect(queries.search({ q: ref }).map((item) => item.id)).toEqual([feature.id]);
    }
    expect(queries.search({ q: feature.key, kind: "task" })).toEqual([]);
    expect(queries.search({ q: "FEATURE-" })).toEqual([]);
    failure(() => queries.get(`task:${feature.id}`), "NOT_FOUND");
    failure(() => queries.get("unsupported:KEY"), "INVALID_ARGUMENT");
  });

  test("обзор и status сохраняют полные счётчики и формы результатов", () => {
    const blocker = tasks.create({ title: "Блокер" }, actor);
    tasks.create({ title: "Зависимая", column: "ready", dependencies: [blocker.id] }, actor);
    const overview = queries.overview();
    expect(overview.project.id).toBe(db.projectId);
    expect(overview.items).toHaveLength(5);
    expect(overview.counts.task).toBe(2);
    expect(overview.tasks).toMatchObject({
      total: 2,
      blocked: 1,
      columns: { inbox: 1, ready: 1, done: 0 },
    });
    expect(queries.status()).toMatchObject({
      projectId: db.projectId,
      databasePath: db.path,
      generation: overview.generation,
      records: 5,
    });
    expect(queries.status().bytes).toBeGreaterThan(0);
    expect(queries.check()).toEqual({
      projectId: db.projectId,
      generation: overview.generation,
      valid: true,
      records: 5,
      issues: [],
    });
  });

  test("doctor проверяет реальные ссылки, их типы и граф обязательств", () => {
    const first = tasks.create({ title: "Первая" }, actor);
    const second = tasks.create({ title: "Вторая", dependencies: [first.id] }, actor);
    db.update(
      {
        ...first,
        revision: 2,
        data: {
          ...first.data,
          boardId: second.id,
          dependencies: [second.id],
          targets: ["missing-id"],
        },
      },
      first.revision,
    );
    const error = failure(() => queries.check(), "INTEGRITY_ERROR");
    expect(error.exitCode).toBe(1);
    expect(error.details?.valid).toBe(false);
    expect(String(error.details?.issues)).toContain("missing-id");
    expect(String(error.details?.issues)).toContain("тип ссылки");
    expect(String(error.details?.issues)).toContain("TASK_CYCLE");
  });

  test("doctor не принимает дублированный паспорт продукта и проверяет записи всех областей", () => {
    const feature = knowledge.create("feature", { name: "Фича", description: "Содержание" }, actor);
    const app = knowledge.create(
      "application",
      { name: "Web", slug: "web", description: "Интерфейс" },
      actor,
    );
    knowledge.replaceParticipation(app.id, [feature.id], write(app));
    const history = new HistoryService(db);
    const session = history.start({ title: "Поручение" }, actor);
    history.checkpoint(
      session.id,
      "open",
      { title: "Намерение", body: "Материал", runId: session.data.currentRunId },
      write(session),
    );
    expect(queries.check().valid).toBe(true);
    entities.create("product", "PRODUCT", {}, actor);
    expect(failure(() => queries.check(), "INTEGRITY_ERROR").message).toContain(
      "единственный паспорт",
    );
  });

  test("обзор удерживает поколение и состав снимка, пока другое соединение сохраняет данные", () => {
    const writer = ProjectDatabase.open(db.path);
    const originalList = db.list.bind(db);
    const generation = db.getGeneration();
    let written = false;
    const list = spyOn(db, "list").mockImplementation((kind) => {
      const records = originalList(kind);
      if (!written) {
        written = true;
        new TasksService(writer).create({ title: "После начала снимка" }, actor);
      }
      return records;
    });
    try {
      const overview = queries.overview();
      expect(overview.generation).toBe(generation);
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
