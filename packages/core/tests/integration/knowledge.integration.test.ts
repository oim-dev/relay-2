import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { RelayError, type EntityRecord, type WriteOptions } from "@relay/contracts";
import { ProjectDatabase } from "@relay/storage";
import { KnowledgeService } from "../../src/knowledge";
import { PlanningService } from "../../src/planning";
import { TasksService } from "../../src/tasks";

function fixture(run: (service: KnowledgeService, db: ProjectDatabase) => void): void {
  const artifacts = resolve(
    import.meta.dir,
    "../../../../.artifacts",
    new Date().toISOString().slice(0, 10),
  );
  mkdirSync(artifacts, { recursive: true });
  const root = mkdtempSync(resolve(artifacts, "knowledge-sqlite-"));
  let db: ProjectDatabase | undefined;
  try {
    db = ProjectDatabase.create(resolve(root, "project.sqlite"), {
      id: crypto.randomUUID(),
      name: "Библиотека",
      slug: "library",
    });
    run(new KnowledgeService(db), db);
  } finally {
    db?.close();
    rmSync(root, { recursive: true, force: true });
  }
}

const write = (entity: EntityRecord): WriteOptions => ({
  actor: "tester",
  ifRevision: entity.revision,
});

function fails(operation: () => unknown, code: string): void {
  let caught: unknown;
  try {
    operation();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(RelayError);
  expect((caught as RelayError).code).toBe(code);
}

function requirements(service: KnowledgeService) {
  const feature = service.create(
    "feature",
    { name: "Поиск", description: "## Требования\n\nНайти инструкцию.\n" },
    "tester",
  );
  const scenario = service.create(
    "scenario",
    { name: "Найти по имени", feature: feature.key, description: "Открыть полный текст." },
    "tester",
  );
  const application = service.create(
    "application",
    { name: "Web", slug: "web", prefix: "WEB", description: "Интерфейс библиотеки." },
    "tester",
  );
  return { feature, scenario, application };
}

describe("KnowledgeService и файловая SQLite", () => {
  test("project update согласован с Runtime: trim имени, границы длины и строгий slug", () =>
    fixture((service, db) => {
      let project = service.get("project");
      project = service.update("project", undefined, { name: "  Я  ", slug: "ab" }, write(project));
      expect(project.data.name).toBe("Я");
      expect(project.data.slug).toBe("ab");
      project = service.update(
        "project",
        project.id,
        {
          name: `  ${"Я".repeat(120)}  `,
          slug: "a".repeat(64),
        },
        write(project),
      );
      expect(project.data.name).toBe("Я".repeat(120));
      expect(project.data.slug).toBe("a".repeat(64));
      const snapshot = db.list();
      const generation = db.getGeneration();
      for (const name of [
        "",
        "  ",
        "Я".repeat(121),
        "Имя\nпроекта",
        "Имя\rпроекта",
        "Имя\tпроекта",
        "Имя\0проекта",
        "Имя\u007fпроекта",
        "Имя\u2028проекта",
        "Имя\u2029проекта",
      ]) {
        fails(
          () => service.update("project", project.id, { name }, write(project)),
          "INVALID_ARGUMENT",
        );
      }
      for (const slug of [
        "",
        "a",
        "a".repeat(65),
        "ab\n",
        "ab\r\n",
        "ab\u2028",
        " ab",
        "ab ",
        "AB",
        "ab--cd",
        "-ab",
        "ab-",
        "ab_cd",
        "аб",
      ]) {
        fails(
          () => service.update("project", project.id, { slug }, write(project)),
          "INVALID_ARGUMENT",
        );
        fails(
          () => service.create("application", { name: "Web", slug, prefix: "WEB" }, "tester"),
          "INVALID_ARGUMENT",
        );
      }
      expect(db.list()).toEqual(snapshot);
      expect(db.getGeneration()).toBe(generation);
      for (const [slug, prefix] of [
        ["ab", "SHORT"],
        ["a".repeat(64), "LONG"],
      ]) {
        const app = service.create("application", { name: "Приложение", slug, prefix }, "tester");
        expect(service.get("board", app.data.boardId as string).data.slug).toBe(slug);
      }
    }));

  test("доской владеет приложение: имя меняется атомарно, прямые create/update запрещены", () =>
    fixture((service, db) => {
      const productBoard = service.get("board", "BOARD-PRODUCT");
      expect(service.list("board")).toEqual([productBoard]);
      fails(
        () =>
          service.create("board", { name: "Обход", slug: "custom", prefix: "CUSTOM" }, "tester"),
        "INVALID_ARGUMENT",
      );
      fails(
        () => service.update("board", productBoard.id, { name: "Обход" }, write(productBoard)),
        "INVALID_ARGUMENT",
      );
      fails(
        () =>
          service.update("board", productBoard.id, { description: "Обход" }, write(productBoard)),
        "INVALID_ARGUMENT",
      );
      expect(service.list("board")).toEqual([productBoard]);

      let app = service.create("application", { name: "Web", slug: "web" }, "tester");
      let board = service.get("board", app.data.boardId as string);
      fails(
        () => service.update("board", board.id, { name: "Чужое имя" }, write(board)),
        "INVALID_ARGUMENT",
      );
      board = service.rename("board", board.id, "FRONTEND-TASKS", write(board));
      const previousBoard = board;
      app = service.update(
        "application",
        app.id,
        { name: "Web-клиент" },
        { ...write(app), actor: "editor" },
      );
      board = service.get("board", board.id);
      expect(app.data.name).toBe("Web-клиент");
      expect(board.data).toEqual({ ...previousBoard.data, name: "Web-клиент" });
      expect(board.key).toBe("FRONTEND-TASKS");
      expect(board.revision).toBe(previousBoard.revision + 1);
      expect(board.updatedBy).toBe("editor");
      expect(service.list("board", { application: app.id })).toEqual([board]);

      const snapshot = db.list();
      const generation = db.getGeneration();
      expect(service.update("application", app.id, { name: "Web-клиент" }, write(app))).toEqual(
        app,
      );
      expect(db.list()).toEqual(snapshot);
      expect(db.getGeneration()).toBe(generation);

      // Отказ реальной SQLite на второй записи должен откатить уже записанное
      // имя приложения, ревизии обеих записей и поколение базы.
      const connection = new Database(db.path, { create: false, readwrite: true });
      try {
        connection.exec(`
          CREATE TRIGGER knowledge_reject_board_name BEFORE UPDATE ON entities
          WHEN NEW.kind = 'board' AND json_extract(NEW.data, '$.name') = 'Отклонённое имя'
          BEGIN SELECT RAISE(ABORT, 'knowledge board write failure'); END;
        `);
        fails(
          () => service.update("application", app.id, { name: "Отклонённое имя" }, write(app)),
          "CONFLICT",
        );
        expect(db.list()).toEqual(snapshot);
        expect(db.getGeneration()).toBe(generation);
      } finally {
        connection.close();
      }
    }));

  test("пустой singleton, полные тексты, смена ключа и повторное открытие", () =>
    fixture((service, db) => {
      const empty = service.get("product");
      expect(empty.data).toEqual({});
      const markdown = `## Назначение\n\n${"Требование 🧭\n".repeat(300)}\nПоследняя строка.\n`;
      const product = service.create(
        "product",
        { name: "Библиотека", summary: "Кратко\nВторая строка", description: markdown },
        "tester",
      );
      expect(product.id).toBe(empty.id);
      expect(service.list("product")).toHaveLength(1);
      fails(() => service.create("product", { name: "Вторая копия" }, "tester"), "ALREADY_EXISTS");
      const renamed = service.rename("product", product.key, "LIBRARY", write(product));
      expect(service.get("product").id).toBe(product.id);
      expect(service.get("product", "PRODUCT").key).toBe("LIBRARY");
      expect(renamed.data.description).toBe(markdown);
      const connection = ProjectDatabase.open(db.path);
      try {
        expect(new KnowledgeService(connection).get("product")).toEqual(renamed);
      } finally {
        connection.close();
      }
    }));

  test("создание приложения с доской откатывает уже сделанную запись и счётчик при конфликте ключа", () =>
    fixture((service, db) => {
      const feature = service.create("feature", { name: "Зарезервированный адрес" }, "tester");
      service.rename("feature", feature.key, "BOARD-WEB", write(feature));
      const snapshot = db.list();
      const generation = db.getGeneration();
      fails(
        () => service.create("application", { name: "Web", slug: "web", prefix: "WEB" }, "tester"),
        "CONFLICT",
      );
      expect(db.list()).toEqual(snapshot);
      expect(db.getGeneration()).toBe(generation);
      const app = service.create("application", { name: "API", slug: "api" }, "tester");
      expect(app.key).toBe("APP-1");
      const board = service.get("board", app.data.boardId as string);
      expect(board.data.applicationId).toBe(app.id);
      expect(board.data.slug).toBe("api");
      expect(board.data.prefix).toBe("API");
      const renamed = service.rename("application", app.key, "API", write(app));
      expect(renamed.data).toEqual(app.data);
      fails(
        () => service.update("application", app.id, { slug: "different" }, write(renamed)),
        "INVALID_ARGUMENT",
      );
      fails(
        () => service.update("board", board.id, { applicationId: feature.id }, write(board)),
        "INVALID_ARGUMENT",
      );
    }));

  test("чужие slug и prefix нельзя перехватить ключом доски или приложения", () =>
    fixture((service, db) => {
      const productBoard = service.get("board", "product");
      const web = service.create("application", { name: "Web", slug: "web" }, "tester");
      const api = service.create("application", { name: "API", slug: "api" }, "tester");
      const webBoard = service.get("board", web.data.boardId as string);
      const snapshot = db.list();
      const generation = db.getGeneration();
      for (const [entity, addresses] of [
        [webBoard, ["product", "PRODUCT", "api", "API"]],
        [web, ["api", "API"]],
      ] as const) {
        for (const address of addresses) {
          fails(() => service.rename(entity.kind, entity.id, address, write(entity)), "CONFLICT");
          expect(db.list()).toEqual(snapshot);
          expect(db.getGeneration()).toBe(generation);
        }
      }
      const tasks = new TasksService(db);
      for (const address of ["product", "PRODUCT"]) {
        const task = tasks.create({ board: address, title: "Работа продукта" }, "tester");
        expect(task.data.boardId).toBe(productBoard.id);
        expect(task.key).toStartWith("PRODUCT-");
      }
      const feature = service.create("feature", { name: "Поиск" }, "tester");
      const selected = service.replaceParticipation("api", [feature.id], write(api));
      expect(selected.id).toBe(api.id);
      expect(service.list("implementation", { application: web.id })).toEqual([]);
      expect(service.list("implementation", { application: api.id })).toHaveLength(1);
    }));

  test.each(["board", "application"] as const)(
    "создание не перехватывает ключи и алиасы %s новыми slug/prefix и откатывает счётчик",
    (selected) =>
      fixture((service, db) => {
        const owner = service.create("application", { name: "Web", slug: "web" }, "tester");
        let entity =
          selected === "application" ? owner : service.get("board", owner.data.boardId as string);
        for (const address of ["future", "FUTURE"]) {
          entity = service.rename(selected, entity.id, address, write(entity));
          for (const retired of [false, true]) {
            if (retired)
              entity = service.rename(selected, entity.id, `OWNER-${address}`, write(entity));
            const snapshot = db.list();
            const generation = db.getGeneration();
            fails(
              () =>
                service.create(
                  "application",
                  {
                    name: "Новое приложение",
                    slug: address === "future" ? address : "new-app",
                    prefix: address === "FUTURE" ? address : "NEWAPP",
                  },
                  "tester",
                ),
              "CONFLICT",
            );
            expect(db.list()).toEqual(snapshot);
            expect(db.getGeneration()).toBe(generation);
            expect(service.get(selected, address).id).toBe(entity.id);
          }
        }
        const next = service.create("application", { name: "API", slug: "api" }, "tester");
        expect(next.key).toBe("APP-2");
        expect(service.list("board")).toHaveLength(3);
      }),
  );

  test.each(["board", "application"] as const)(
    "%s сохраняет собственные slug, prefix, ключи и алиасы при переименовании",
    (selected) =>
      fixture((service, db) => {
        const app = service.create("application", { name: "Web", slug: "web" }, "tester");
        let entity =
          selected === "application" ? app : service.get("board", app.data.boardId as string);
        const originalKey = entity.key;
        for (const key of ["web", "WEB", "OTHER", "web", originalKey]) {
          entity = service.rename(selected, entity.id, key, write(entity));
          for (const address of ["web", "WEB", originalKey, entity.id]) {
            expect(service.get(selected, address).id).toBe(entity.id);
            expect(service.get(selected, `${selected}:${address}`).id).toBe(entity.id);
          }
        }
        const generation = db.getGeneration();
        expect(service.rename(selected, entity.id, entity.key, write(entity))).toEqual(entity);
        expect(db.getGeneration()).toBe(generation);
      }),
  );

  test("выдача ключа пропускает чужой prefix и не блокирует создание следующих приложений", () =>
    fixture((service) => {
      const app = service.create(
        "application",
        { name: "Web", slug: "web", prefix: "APP-2" },
        "tester",
      );
      const next = service.create("application", { name: "API", slug: "api" }, "tester");
      expect(next.key).toBe("APP-3");
      expect(service.get("application", "APP-2").id).toBe(app.id);
      expect(service.get("application", next.key).id).toBe(next.id);
    }));

  test("конфликт ключа новой доски с чужим prefix откатывает приложение, поколение и счётчик", () =>
    fixture((service, db) => {
      const app = service.create(
        "application",
        { name: "Web", slug: "web", prefix: "BOARD-API" },
        "tester",
      );
      const snapshot = db.list();
      const generation = db.getGeneration();
      fails(
        () => service.create("application", { name: "API", slug: "api" }, "tester"),
        "CONFLICT",
      );
      expect(db.list()).toEqual(snapshot);
      expect(db.getGeneration()).toBe(generation);
      expect(service.get("board", "BOARD-API").id).toBe(app.data.boardId as string);
      const next = service.create("application", { name: "CLI", slug: "cli" }, "tester");
      expect(next.key).toBe("APP-2");
    }));

  test("типизированная цель документа не перенаправляется буквальным ключом другой фичи", () =>
    fixture((service, db) => {
      const feature = service.create("feature", { name: "Поиск" }, "tester");
      const other = service.create("feature", { name: "Другая фича" }, "tester");
      const target = `feature:${feature.key}`;
      const snapshot = db.list();
      const generation = db.getGeneration();
      fails(() => service.rename("feature", other.id, target, write(other)), "VALIDATION_ERROR");
      expect(db.list()).toEqual(snapshot);
      expect(db.getGeneration()).toBe(generation);
      // Storage также запрещает коллизию, если вызывающий обошёл предметный сервис.
      fails(() => db.rename(other.id, target, other.revision, "tester"), "VALIDATION_ERROR");
      let doc = service.create(
        "document",
        { name: "Материал", body: "Текст", targets: [target] },
        "tester",
      );
      expect(doc.data.relations).toEqual([
        { target: { kind: "feature", id: feature.id }, type: "documents", description: "" },
      ]);
      doc = service.linkDocument(`document:${doc.id}`, `feature:${feature.id}`, {
        ...write(doc),
        type: "references",
      });
      expect(service.list("document", { target })).toEqual([doc]);
      expect(service.list("document", { target: other.id })).toEqual([]);
      const beforeMismatch = db.list();
      const beforeMismatchGeneration = db.getGeneration();
      fails(() => service.get("document", target), "INVALID_ARGUMENT");
      fails(
        () =>
          service.update(
            "document",
            doc.id,
            { relations: [{ target: { kind: "document", id: target } }] },
            write(doc),
          ),
        "INVALID_ARGUMENT",
      );
      expect(db.list()).toEqual(beforeMismatch);
      expect(db.getGeneration()).toBe(beforeMismatchGeneration);
    }));

  test("задачи и планирование разрешают типизированные ссылки через общий EntityService", () =>
    fixture((service, db) => {
      const feature = service.create("feature", { name: "Поиск" }, "tester");
      const tasks = new TasksService(db);
      const planning = new PlanningService(db);
      const task = tasks.create(
        { title: "Реализовать поиск", targets: [`feature:${feature.key}`] },
        "tester",
      );
      expect(task.data.targets).toEqual([feature.id]);
      expect(tasks.get(`task:${task.id}`).id).toBe(task.id);
      const plan = planning.create(
        "work-plan",
        {
          title: "План поиска",
          goal: "Дать пользователю поиск",
          scope: [{ kind: "feature", id: `feature:${feature.id}` }],
        },
        "tester",
      );
      expect(planning.get("work-plan", `work-plan:${plan.key}`)).toEqual(plan);
      const release = planning.create(
        "release",
        { title: "Выпуск", version: "1.0.0", planIds: [`work-plan:${plan.id}`] },
        "tester",
      );
      expect(release.data.planIds).toEqual([plan.id]);
      const snapshot = db.list();
      const generation = db.getGeneration();
      fails(() => tasks.get(`feature:${task.id}`), "INVALID_ARGUMENT");
      fails(() => planning.get("work-plan", `release:${plan.id}`), "INVALID_ARGUMENT");
      expect(db.list()).toEqual(snapshot);
      expect(db.getGeneration()).toBe(generation);
    }));

  test("SI требует FI своего приложения; постоянные ссылки переживают переименование", () =>
    fixture((service, db) => {
      const { feature, scenario, application } = requirements(service);
      const another = service.create("application", { name: "API", slug: "api" }, "tester");
      fails(
        () =>
          service.create(
            "implementation",
            { application: application.key, target: scenario.key, title: "SI" },
            "tester",
          ),
        "INVALID_ARGUMENT",
      );
      const fi = service.create(
        "implementation",
        {
          application: application.id,
          target: feature.key,
          title: "Поиск в Web",
          description: "Полный вклад\n\n🧭\n",
          status: "partial",
        },
        "tester",
      );
      fails(
        () =>
          service.create(
            "implementation",
            { application: another.key, target: scenario.key, title: "Другая SI" },
            "tester",
          ),
        "INVALID_ARGUMENT",
      );
      const si = service.create(
        "implementation",
        { application: application.key, target: scenario.id, title: "Поиск по имени" },
        "tester",
      );
      const renamed = service.rename("feature", feature.key, "SEARCH", write(feature));
      expect(service.get("scenario", scenario.key).data.featureId).toBe(feature.id);
      expect(service.get("implementation", fi.key).data.targetId).toBe(renamed.id);
      expect(service.get("implementation", si.key).data.featureId).toBe(renamed.id);
      expect(service.get("implementation", si.key).data.scenarioId).toBe(scenario.id);
      expect(
        service
          .list("implementation", { application: application.key, feature: "SEARCH" })
          .map((item) => item.id)
          .sort(),
      ).toEqual([fi.id, si.id].sort());
      const before = db.list();
      fails(
        () =>
          service.create(
            "implementation",
            { application: application.key, target: feature.key, title: "Дубликат" },
            "tester",
          ),
        "ALREADY_EXISTS",
      );
      fails(
        () => service.update("scenario", scenario.id, { featureId: feature.id }, write(scenario)),
        "INVALID_ARGUMENT",
      );
      fails(
        () => service.update("implementation", fi.id, { active: false }, write(fi)),
        "INVALID_ARGUMENT",
      );
      fails(
        () => service.replaceParticipation(another.id, [fi.id], write(another)),
        "INVALID_ARGUMENT",
      );
      expect(db.list()).toEqual(before);
    }));

  test("замена состава проверяется целиком; снятие и возврат сохраняют адрес, текст и ссылки", () =>
    fixture((service, db) => {
      const { feature, scenario, application } = requirements(service);
      const emptyGeneration = db.getGeneration();
      expect(service.replaceParticipation(application.id, [], write(application))).toEqual(
        application,
      );
      expect(db.getGeneration()).toBe(emptyGeneration);
      const selected = service.replaceParticipation(
        application.key,
        [scenario.key, feature.key],
        write(application),
      );
      const fi = service.list("implementation", { target: feature.key })[0]!;
      let si = service.list("implementation", { target: scenario.key })[0]!;
      si = service.update(
        "implementation",
        si.id,
        {
          title: "Собственный вклад",
          description: "## Поведение\n\nТекст сохраняется.\n",
          status: "done",
        },
        write(si),
      );
      let doc = service.create(
        "document",
        {
          name: "Материалы",
          body: "Полный текст",
          relations: [{ target: si.key, type: "references", description: "Основание" }],
        },
        "tester",
      );
      const before = db.list();
      const generation = db.getGeneration();
      expect(
        service.replaceParticipation(application.id, [fi.id, si.key], write(selected)),
      ).toEqual(selected);
      expect(db.list()).toEqual(before);
      expect(db.getGeneration()).toBe(generation);
      fails(
        () => service.replaceParticipation(application.id, [fi.id, si.key], write(application)),
        "REVISION_CONFLICT",
      );
      for (const targets of [
        [scenario.key],
        [feature.key, "UNKNOWN"],
        [feature.key, feature.id],
        [doc.key],
      ]) {
        fails(
          () => service.replaceParticipation(application.key, targets, write(selected)),
          targets.includes("UNKNOWN") ? "NOT_FOUND" : "INVALID_ARGUMENT",
        );
        expect(db.list()).toEqual(before);
        expect(db.getGeneration()).toBe(generation);
      }
      const inactive = service.replaceParticipation(application.key, [], write(selected));
      expect(service.list("implementation", { active: true })).toEqual([]);
      expect(service.get("implementation", fi.key).data.active).toBe(false);
      const inactiveSi = service.get("implementation", si.key);
      expect(inactiveSi.id).toBe(si.id);
      expect(inactiveSi.data.description).toBe(si.data.description);
      expect(service.get("document", doc.id).data.relations).toEqual(doc.data.relations);
      fails(
        () => service.linkDocument(doc.key, si.key, { ...write(doc), type: "documents" }),
        "INVALID_ARGUMENT",
      );
      doc = service.linkDocument(doc.key, si.key, {
        ...write(doc),
        type: "references",
        description: "Прежняя связь остаётся доступной",
      });
      const edited = service.update(
        "implementation",
        si.key,
        { description: "Уточнённый снятый вклад" },
        write(inactiveSi),
      );
      expect(edited.data.active).toBe(false);
      const restored = service.replaceParticipation(
        application.key,
        [fi.key, si.id],
        write(inactive),
      );
      expect(restored.data.implementationIds).toEqual([fi.id, si.id].sort());
      expect(service.get("implementation", si.key).data).toEqual({ ...edited.data, active: true });
      expect(service.get("document", doc.id).data.relations).toEqual(doc.data.relations);
      expect(service.list("implementation")).toHaveLength(2);
    }));

  test("ошибка нового состава откатывает внешнюю SQLite-транзакцию с уже созданными FI/SI", () =>
    fixture((service, db) => {
      const { feature, scenario, application } = requirements(service);
      const snapshot = db.list();
      const generation = db.getGeneration();
      fails(
        () =>
          db.transaction(() => {
            const selected = service.replaceParticipation(
              application.key,
              [feature.key, scenario.key],
              write(application),
            );
            expect(service.list("implementation")).toHaveLength(2);
            service.replaceParticipation(application.id, [scenario.key], write(selected));
          }),
        "INVALID_ARGUMENT",
      );
      expect(db.list()).toEqual(snapshot);
      expect(db.getGeneration()).toBe(generation);
      service.replaceParticipation(
        application.key,
        [feature.key, scenario.key],
        write(application),
      );
      expect(service.list("implementation").map((item) => item.key)).toEqual([
        "WEB-FI-1",
        "WEB-SI-1",
      ]);
    }));

  test("разделы упорядочиваются; удаление не переписывает документ, ID раздела не переиспользуется", () =>
    fixture((service, db) => {
      let project = service.get("project");
      project = service.changeSection(
        "create",
        { id: "guides", name: "Руководства" },
        write(project),
      );
      project = service.changeSection("create", { id: "rules", name: "Правила" }, write(project));
      project = service.changeSection("move", { id: "rules", before: "guides" }, write(project));
      expect(project.data.documentSections).toEqual([
        { id: "rules", name: "Правила" },
        { id: "guides", name: "Руководства" },
      ]);
      project = service.changeSection(
        "update",
        { id: "guides", name: "Инструкции" },
        write(project),
      );
      project = service.changeSection("move", { id: "rules", before: null }, write(project));
      const doc = service.create(
        "document",
        { name: "Как искать", body: "# Поиск\n\nПоследний абзац.\n", sectionId: "guides" },
        "tester",
      );
      project = service.changeSection("remove", { id: "guides" }, write(project));
      const effective = service.get("document", doc.key);
      expect(effective.data.sectionId).toBeNull();
      expect(effective.revision).toBe(doc.revision);
      expect(effective.updatedAt).toBe(doc.updatedAt);
      expect(effective.updatedBy).toBe(doc.updatedBy);
      expect(db.get(doc.id)).toEqual(doc);
      expect(service.list("document", { section: "none" }).map((item) => item.id)).toEqual([
        doc.id,
      ]);
      fails(
        () =>
          service.changeSection("create", { id: "guides", name: "Другой раздел" }, write(project)),
        "ALREADY_EXISTS",
      );
      fails(
        () => service.changeSection("move", { id: "rules", before: "rules" }, write(project)),
        "INVALID_ARGUMENT",
      );
      fails(
        () => service.update("document", doc.id, { sectionId: "guides" }, write(doc)),
        "NOT_FOUND",
      );
      const updated = service.update(
        "document",
        doc.id,
        { summary: "Новая аннотация" },
        write(doc),
      );
      expect(updated.data.sectionId).toBeNull();
      expect(db.get(doc.id)?.data.sectionId).toBe("guides");
    }));

  test("документ: типы связей, полные пояснения, адреса и открепление по паре цель + тип", () =>
    fixture((service, db) => {
      const feature = service.create("feature", { name: "Поиск" }, "tester");
      let doc = service.create(
        "document",
        {
          name: "Исследование",
          body: "# Исследование\n\nВывод.\n",
          documentKind: "research",
          documentStatus: "active",
          pinned: true,
        },
        "tester",
      );
      const description = "## Зачем читать\n\nПолное основание 🧭.\n";
      doc = service.linkDocument(doc.key, feature.key, {
        ...write(doc),
        type: "documents",
        description,
      });
      doc = service.linkDocument(doc.key, feature.id, {
        ...write(doc),
        type: "references",
        description: "Другое отношение",
      });
      const renamed = service.rename("feature", feature.id, "LOOKUP", write(feature));
      expect(
        service.list("document", {
          target: renamed.key,
          pinned: true,
          documentKind: "research",
          status: "active",
        }),
      ).toEqual([doc]);
      expect(doc.data.relations).toEqual([
        { target: { kind: "feature", id: feature.id }, type: "documents", description },
        {
          target: { kind: "feature", id: feature.id },
          type: "references",
          description: "Другое отношение",
        },
      ]);
      const snapshot = db.list();
      fails(
        () =>
          service.update(
            "document",
            doc.id,
            {
              relations: [{ target: feature.key }, { target: { kind: "feature", id: feature.id } }],
            },
            write(doc),
          ),
        "INVALID_ARGUMENT",
      );
      fails(() => service.linkDocument(doc.key, doc.id, write(doc)), "INVALID_ARGUMENT");
      fails(
        () =>
          service.update(
            "document",
            doc.id,
            { relations: [{ target: feature.key, typo: true }] },
            write(doc),
          ),
        "INVALID_ARGUMENT",
      );
      expect(db.list()).toEqual(snapshot);
      doc = service.linkDocument(doc.key, feature.key, {
        ...write(doc),
        remove: true,
        type: "references",
      });
      expect(doc.data.relations).toEqual([
        { target: { kind: "feature", id: feature.id }, type: "documents", description },
      ]);
      expect(service.get("feature", feature.key).key).toBe("LOOKUP");
      expect(service.linkDocument(doc.key, feature.key, write(doc))).toEqual(doc);
    }));

  test("устаревшая ревизия отвергается до no-op на двух соединениях и не повторяется автоматически", () =>
    fixture((service, db) => {
      const feature = service.create("feature", { name: "Поиск" }, "tester");
      const doc = service.create("document", { name: "Материал", body: "Текст" }, "tester");
      const application = service.create("application", { name: "Web", slug: "web" }, "tester");
      const project = service.get("project");
      const connection = ProjectDatabase.open(db.path);
      try {
        const second = new KnowledgeService(connection);
        const updated = second.update(
          "feature",
          feature.id,
          { name: "Новый поиск" },
          write(feature),
        );
        const linked = second.linkDocument(doc.id, updated.id, write(doc));
        second.replaceParticipation(application.id, [updated.id], write(application));
        second.changeSection("create", { id: "rules", name: "Правила" }, write(project));
        const snapshot = db.list();
        const generation = db.getGeneration();
        fails(
          () => service.update("feature", feature.id, { name: "Новый поиск" }, write(feature)),
          "REVISION_CONFLICT",
        );
        fails(
          () => service.rename("feature", feature.id, feature.key, write(feature)),
          "REVISION_CONFLICT",
        );
        fails(() => service.linkDocument(doc.id, feature.id, write(doc)), "REVISION_CONFLICT");
        fails(
          () => service.replaceParticipation(application.id, [feature.id], write(application)),
          "REVISION_CONFLICT",
        );
        fails(
          () => service.changeSection("update", { id: "rules", name: "Правила" }, write(project)),
          "REVISION_CONFLICT",
        );
        expect(db.list()).toEqual(snapshot);
        expect(db.getGeneration()).toBe(generation);
        expect(service.linkDocument(doc.id, feature.id, write(linked))).toEqual(linked);
      } finally {
        connection.close();
      }
    }));

  test("публичные методы не дают обойти владельцев видов, типы и неизменяемые поля", () =>
    fixture((service, db) => {
      const { feature, scenario, application } = requirements(service);
      const snapshot = db.list();
      for (const operation of [
        () => service.create("task", { name: "Обход" }, "tester"),
        () => service.get("work-plan", feature.id),
        () => service.list("release"),
        () => service.update("task", feature.id, {}, write(feature)),
        () => service.rename("work-checkpoint", feature.id, "OTHER", write(feature)),
        () => service.create("feature", { name: "Имя", unknown: true }, "tester"),
        () => service.create("feature", { name: ["Имя"] }, "tester"),
        () => service.create("feature", { name: "Первая\nВторая" }, "tester"),
        () => service.create("document", { name: "Документ", body: " " }, "tester"),
        () =>
          service.create(
            "document",
            { name: "Документ", body: "Текст", pinned: "false" },
            "tester",
          ),
        () =>
          service.create(
            "document",
            { name: "Документ", body: "Текст", documentKind: "unknown" },
            "tester",
          ),
        () =>
          service.create(
            "scenario",
            { name: "Сценарий", feature: feature.id, featureId: feature.id },
            "tester",
          ),
        () => service.update("scenario", scenario.id, { feature: feature.id }, write(scenario)),
        () =>
          service.update(
            "application",
            application.id,
            { implementationIds: [] },
            write(application),
          ),
        () =>
          service.update(
            "project",
            undefined,
            { documentSections: [] },
            write(service.get("project")),
          ),
        () => service.list("feature", { unknown: "value" }),
        () => service.list("implementation", { active: "false" }),
        () => service.replaceParticipation(application.id, [scenario.id], write(application)),
      ])
        fails(operation, "INVALID_ARGUMENT");
      expect(db.list()).toEqual(snapshot);
    }));
});
