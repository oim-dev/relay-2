import { describe, expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import type { EntityKind, EntityPage, EntityPageRequest, EntityRecord } from "@relay/contracts";
import { ProjectDatabase } from "@relay/storage";
import { KnowledgeService } from "../../src/knowledge/knowledge";
import { PlanningService } from "../../src/planning/planning";
import { TasksService } from "../../src/tasks/tasks";
import { entityWriteOptions as write, expectRelayError } from "./helpers/entity-fixture";
import {
  corruptKnowledgeRecord,
  createKnowledgeParticipation,
  createKnowledgeRequirements,
  withKnowledgeFixture,
} from "./helpers/knowledge-fixture";

const pageFilters = [
  { name: "без предметного фильтра", filters: {} },
  { name: "с предметным фильтром", filters: { q: "needle" } },
] as const;
const invalidPageRequests = [
  { name: "отрицательное смещение", request: { offset: -1, limit: 1, sort: "key" } },
  { name: "нулевой лимит", request: { offset: 0, limit: 0, sort: "key" } },
  { name: "слишком большой лимит", request: { offset: 0, limit: 101, sort: "key" } },
  { name: "неизвестный порядок", request: { offset: 0, limit: 1, sort: "invalid" } },
] as const;
const corruptedRelations = [
  { name: "null вместо списка", relations: null },
  { name: "неверная цель", relations: [{ target: null, type: "documents", description: "" }] },
  {
    name: "неверный вид цели",
    relations: [
      { target: { id: "target", kind: "work-session" }, type: "documents", description: "" },
    ],
  },
  {
    name: "неверный тип отношения",
    relations: [{ target: { id: "target", kind: "feature" }, type: "invalid", description: "" }],
  },
  {
    name: "неверное описание",
    relations: [{ target: { id: "target", kind: "feature" }, type: "documents", description: 42 }],
  },
  {
    name: "повтор пары",
    relations: [
      { target: { id: "target", kind: "feature" }, type: "documents", description: "" },
      { target: { id: "target", kind: "feature" }, type: "documents", description: "" },
    ],
  },
] as const;
const corruptedSectionCollections = [
  { name: "null вместо разделов", patch: { documentSections: null } },
  { name: "раздел без имени", patch: { documentSections: [{ id: "guides" }] } },
  {
    name: "дубли разделов",
    patch: {
      documentSections: [
        { id: "guides", name: "Первый" },
        { id: "guides", name: "Второй" },
      ],
    },
  },
  { name: "null вместо удалённых ID", patch: { retiredDocumentSectionIds: null } },
  { name: "дубли удалённых ID", patch: { retiredDocumentSectionIds: ["guides", "guides"] } },
  {
    name: "активный ID среди удалённых",
    patch: {
      documentSections: [{ id: "guides", name: "Активный" }],
      retiredDocumentSectionIds: ["guides"],
    },
  },
] as const;
const invalidProjectNames = [
  { name: "пустая строка", value: "" },
  { name: "пробелы", value: "  " },
  { name: "121 символ", value: "Я".repeat(121) },
  { name: "перевод строки", value: "Имя\nпроекта" },
  { name: "возврат каретки", value: "Имя\rпроекта" },
  { name: "табуляция", value: "Имя\tпроекта" },
  { name: "нулевой символ", value: "Имя\0проекта" },
  { name: "DEL", value: "Имя\u007fпроекта" },
  { name: "разделитель строк Unicode", value: "Имя\u2028проекта" },
  { name: "разделитель абзацев Unicode", value: "Имя\u2029проекта" },
] as const;
const invalidSlugs = [
  { name: "пустая строка", value: "" },
  { name: "один символ", value: "a" },
  { name: "65 символов", value: "a".repeat(65) },
  { name: "конечный LF", value: "ab\n" },
  { name: "конечный CRLF", value: "ab\r\n" },
  { name: "разделитель строк Unicode", value: "ab\u2028" },
  { name: "начальный пробел", value: " ab" },
  { name: "конечный пробел", value: "ab " },
  { name: "верхний регистр", value: "AB" },
  { name: "двойной дефис", value: "ab--cd" },
  { name: "начальный дефис", value: "-ab" },
  { name: "конечный дефис", value: "ab-" },
  { name: "подчёркивание", value: "ab_cd" },
  { name: "кириллица", value: "аб" },
] as const;
const validProjectBoundaries = [
  { name: "минимальной длины", input: { name: "  Я  ", slug: "ab" }, expectedName: "Я" },
  {
    name: "максимальной длины",
    input: { name: `  ${"Я".repeat(120)}  `, slug: "a".repeat(64) },
    expectedName: "Я".repeat(120),
  },
] as const;
const applicationSlugBoundaries = [
  { name: "два символа", slug: "ab", prefix: "SHORT" },
  { name: "64 символа", slug: "a".repeat(64), prefix: "LONG" },
] as const;
const reservedAddresses = [
  { kind: "board", address: "product" },
  { kind: "board", address: "PRODUCT" },
  { kind: "board", address: "api" },
  { kind: "board", address: "API" },
  { kind: "application", address: "api" },
  { kind: "application", address: "API" },
] as const;
const addressOwners = ["board", "application"] as const;
const addressReservations = [
  { name: "ключ slug", address: "future", slug: "future", prefix: "NEWAPP", retired: false },
  { name: "алиас slug", address: "future", slug: "future", prefix: "NEWAPP", retired: true },
  { name: "ключ prefix", address: "FUTURE", slug: "new-app", prefix: "FUTURE", retired: false },
  { name: "алиас prefix", address: "FUTURE", slug: "new-app", prefix: "FUTURE", retired: true },
] as const;
const invalidParticipation = [
  { name: "сценарий без фичи", targets: "scenario", code: "INVALID_ARGUMENT" },
  { name: "неизвестная цель после фичи", targets: "missing", code: "NOT_FOUND" },
  { name: "одна цель по ключу и ID", targets: "duplicate", code: "INVALID_ARGUMENT" },
] as const;
const invalidFeatureInputs = [
  { name: "неизвестное поле", input: { name: "Имя", unknown: true } },
  { name: "массив вместо имени", input: { name: ["Имя"] } },
  { name: "многострочное имя", input: { name: "Первая\nВторая" } },
] as const;
const invalidDocumentInputs = [
  { name: "пустое тело", input: { name: "Документ", body: " " } },
  { name: "строка вместо pinned", input: { name: "Документ", body: "Текст", pinned: "false" } },
  { name: "неизвестный вид", input: { name: "Документ", body: "Текст", documentKind: "unknown" } },
] as const;
const foreignKindOperations = ["create", "get", "list", "update", "rename"] as const;
const corruptedRelationOperations = [
  "get",
  "documentLinks",
  "list",
  "update",
  "linkDocument",
] as const;
const corruptedSectionOperations = ["documentSections", "list", "changeSection"] as const;
const knowledgeReadOperations = ["get", "list"] as const;
const featureRevisionOperations = ["update", "rename"] as const;
const invalidRelationInputs = [
  { name: "дубликат пары", input: "duplicate" },
  { name: "неизвестное поле", input: "unknown-field" },
  { name: "конфликт видов цели", input: "kind-mismatch" },
] as const;
const documentAddressGuards = ["KnowledgeService", "Storage"] as const;
const immutableScenarioFields = ["feature", "featureId"] as const;
const productBoardFields = ["name", "description"] as const;
const productBoardAddresses = ["product", "PRODUCT"] as const;
const sectionMoves = [
  {
    name: "перед первым разделом",
    initialSections: [
      { id: "guides", name: "Руководства" },
      { id: "rules", name: "Правила" },
    ],
    before: "guides",
    expected: [
      { id: "rules", name: "Правила" },
      { id: "guides", name: "Руководства" },
    ],
  },
  {
    name: "в конец списка",
    initialSections: [
      { id: "rules", name: "Правила" },
      { id: "guides", name: "Руководства" },
    ],
    before: null,
    expected: [
      { id: "guides", name: "Руководства" },
      { id: "rules", name: "Правила" },
    ],
  },
] as const;

/**
 * Читает испорченную запись указанным публичным маршрутом и проверяет явный отказ.
 * Данные передаются из Storage после намеренной порчи; helper не изменяет их.
 */
function expectCorruptedKnowledgeRead(
  service: KnowledgeService,
  corruptedRecord: EntityRecord,
  operation: "get" | "list",
): void {
  expectRelayError(() => {
    if (operation === "get") {
      return service.get(corruptedRecord.kind, corruptedRecord.id);
    }
    return service.list(corruptedRecord.kind);
  }, "CORRUPT_DATA");
}

describe("Страницы знаний и согласованный снимок", () => {
  test.each(pageFilters)("страница $name сохраняет total и предметный порядок", ({ filters }) => {
    withKnowledgeFixture((service) => {
      for (const name of ["Äther", "alpha", "Zulu"]) {
        service.create("document", { name, body: "needle" }, "tester");
      }

      const page = service.listPage("document", filters, { offset: 1, limit: 1, sort: "title" });

      expect(page.total).toBe(3);
      expect(page.items.map((item) => item.data.name)).toEqual(["alpha"]);
    });
  });

  test("пустое окно в конце списка сохраняет общее число документов", () => {
    withKnowledgeFixture((service) => {
      service.create("document", { name: "Документ", body: "Текст" }, "tester");

      const page = service.listPage("document", {}, { offset: 1, limit: 1, sort: "title" });

      expect(page).toEqual({ total: 1, items: [] });
    });
  });

  test.each(pageFilters)(
    "Unicode-страница $name сохраняет порядок непарных суррогатов",
    ({ filters }) => {
      withKnowledgeFixture((service) => {
        const names = ["\ud800", "\udc00", "\ue000", "😀"];
        for (const name of names) {
          service.create("feature", { name, description: "needle" }, "tester");
        }

        const page = service.listPage("feature", filters, { offset: 0, limit: 4, sort: "title" });

        expect(page.items.map((item) => item.data.name)).toEqual(names);
      });
    },
  );

  for (const { name, filters } of pageFilters) {
    test.each(invalidPageRequests)(`$name в окне ${name} отклоняется до чтения`, ({ request }) => {
      withKnowledgeFixture((service, db) => {
        const fullRead = spyOn(db, "list");
        const pageRead = spyOn(db, "listPage");
        try {
          // Намеренно неверный транспортный sort проверяет runtime-границу типизированного API.
          expectRelayError(
            () => service.listPage("document", filters, request as EntityPageRequest),
            "INVALID_ARGUMENT",
          );

          expect(fullRead).not.toHaveBeenCalled();
          expect(pageRead).not.toHaveBeenCalled();
        } finally {
          fullRead.mockRestore();
          pageRead.mockRestore();
        }
      });
    });
  }

  test("удаление раздела между чтениями не меняет проекцию текущей страницы", () => {
    withKnowledgeFixture((service, db) => {
      const project = service.changeSection(
        "create",
        { id: "guides", name: "Руководства" },
        write(service.get("project")),
      );
      const document = service.create(
        "document",
        { name: "Документ", body: "Текст", sectionId: "guides" },
        "tester",
      );
      const writer = ProjectDatabase.open(db.path);
      /**
       * Читает настоящее SQL-окно без повторного входа в перехваченный метод.
       */
      const original: (kind: EntityKind, request: EntityPageRequest) => EntityPage<EntityRecord> =
        db.listPage.bind(db);
      const intercepted = spyOn(db, "listPage").mockImplementation((kind, request) => {
        const page = original(kind, request);
        // Commit после SQL-окна, но до разделов проверяет внешний snapshot Core.
        new KnowledgeService(writer).changeSection("remove", { id: "guides" }, write(project));
        return page;
      });
      try {
        const page = service.listPage("document", {}, { offset: 0, limit: 1, sort: "key" });

        expect(page).toEqual({ total: 1, items: [document] });
      } finally {
        intercepted.mockRestore();
        writer.close();
      }
      const after = service.listPage("document", {}, { offset: 0, limit: 1, sort: "key" });
      expect(after.items).toEqual([{ ...document, data: { ...document.data, sectionId: null } }]);
      expect(db.get(document.id)).toEqual(document);
    });
  });
});

describe("Проверка сохранённых знаний", () => {
  for (const operation of corruptedRelationOperations) {
    test.each(corruptedRelations)(
      `${operation}: $name в отношениях даёт CORRUPT_DATA без записи`,
      ({ relations }) => {
        withKnowledgeFixture((service, db) => {
          const feature = service.create("feature", { name: "Цель" }, "tester");
          const document = service.create(
            "document",
            { name: "Документ", body: "Текст", targets: [feature.id] },
            "tester",
          );
          const corruptedRecord = corruptKnowledgeRecord(db, document, { relations });
          const generation = db.getGeneration();

          expectRelayError(() => {
            switch (operation) {
              case "get":
                return service.get("document", document.id);
              case "documentLinks":
                return service.documentLinks(document.id);
              case "list":
                return service.list("document", { target: feature.id });
              case "update":
                return service.update(
                  "document",
                  document.id,
                  { summary: "Правка" },
                  write(corruptedRecord),
                );
              case "linkDocument":
                return service.linkDocument(document.id, feature.id, write(corruptedRecord));
            }
          }, "CORRUPT_DATA");

          expect(db.get(document.id)).toEqual(corruptedRecord);
          expect(db.getGeneration()).toBe(generation);
        });
      },
    );
  }

  for (const operation of corruptedSectionOperations) {
    test.each(corruptedSectionCollections)(
      `${operation}: $name отклоняется без перезаписи проекта`,
      ({ patch }) => {
        withKnowledgeFixture((service, db) => {
          const corruptedRecord = corruptKnowledgeRecord(db, service.get("project"), patch);
          const generation = db.getGeneration();

          expectRelayError(() => {
            switch (operation) {
              case "documentSections":
                return service.documentSections();
              case "list":
                return service.list("document");
              case "changeSection":
                return service.changeSection(
                  "create",
                  { id: "new", name: "Новый" },
                  write(corruptedRecord),
                );
            }
          }, "CORRUPT_DATA");

          expect(db.get(corruptedRecord.id)).toEqual(corruptedRecord);
          expect(db.getGeneration()).toBe(generation);
        });
      },
    );
  }

  for (const operation of knowledgeReadOperations) {
    test(`${operation}: null в summary фичи даёт CORRUPT_DATA`, () => {
      withKnowledgeFixture((service, db) => {
        const feature = service.create("feature", { name: "Фича" }, "tester");
        const corruptedRecord = corruptKnowledgeRecord(db, feature, { summary: null });

        expectCorruptedKnowledgeRead(service, corruptedRecord, operation);
      });
    });

    test(`${operation}: числовая ссылка сценария даёт CORRUPT_DATA`, () => {
      withKnowledgeFixture((service, db) => {
        const feature = service.create("feature", { name: "Фича" }, "tester");
        const scenario = service.create(
          "scenario",
          { name: "Сценарий", feature: feature.id },
          "tester",
        );
        const corruptedRecord = corruptKnowledgeRecord(db, scenario, { featureId: 42 });

        expectCorruptedKnowledgeRead(service, corruptedRecord, operation);
      });
    });

    test(`${operation}: null в составе приложения даёт CORRUPT_DATA`, () => {
      withKnowledgeFixture((service, db) => {
        const application = service.create("application", { name: "Web", slug: "web" }, "tester");
        const corruptedRecord = corruptKnowledgeRecord(db, application, {
          implementationIds: null,
        });

        expectCorruptedKnowledgeRead(service, corruptedRecord, operation);
      });
    });

    test(`${operation}: строковый active реализации даёт CORRUPT_DATA`, () => {
      withKnowledgeFixture((service, db) => {
        const feature = service.create("feature", { name: "Фича" }, "tester");
        const application = service.create("application", { name: "Web", slug: "web" }, "tester");
        const implementation = service.create(
          "implementation",
          { application: application.id, target: feature.id, title: "Вклад" },
          "tester",
        );
        const corruptedRecord = corruptKnowledgeRecord(db, implementation, { active: "false" });

        expectCorruptedKnowledgeRead(service, corruptedRecord, operation);
      });
    });

    test(`${operation}: числовой prefix доски даёт CORRUPT_DATA`, () => {
      withKnowledgeFixture((service, db) => {
        const corruptedRecord = corruptKnowledgeRecord(db, service.get("board", "BOARD-PRODUCT"), {
          prefix: 42,
        });

        expectCorruptedKnowledgeRead(service, corruptedRecord, operation);
      });
    });

    test(`${operation}: null в имени продукта даёт CORRUPT_DATA`, () => {
      withKnowledgeFixture((service, db) => {
        const corruptedRecord = corruptKnowledgeRecord(db, service.get("product"), { name: null });

        expectCorruptedKnowledgeRead(service, corruptedRecord, operation);
      });
    });

    test(`${operation}: неизвестный раздел не маскируется отсутствием раздела`, () => {
      withKnowledgeFixture((service, db) => {
        const document = service.create("document", { name: "Документ", body: "Текст" }, "tester");
        corruptKnowledgeRecord(db, document, { sectionId: "missing" });

        expectRelayError(() => {
          if (operation === "get") {
            return service.get("document", document.id);
          }
          return service.list("document", { section: "none" });
        }, "CORRUPT_DATA");
      });
    });
  }
});

describe("Паспорт продукта и реквизиты проекта", () => {
  test("новая база возвращает пустой паспорт продукта", () => {
    withKnowledgeFixture((service) => {
      const product = service.get("product");

      expect(product.data).toEqual({});
    });
  });

  test("заполнение и переименование паспорта сохраняют singleton и полный текст после открытия БД", () => {
    withKnowledgeFixture((service, db) => {
      const empty = service.get("product");
      const markdown = `## Назначение\n\n${"Требование 🧭\n".repeat(300)}\nПоследняя строка.\n`;
      const product = service.create(
        "product",
        { name: "Библиотека", summary: "Кратко\nВторая строка", description: markdown },
        "tester",
      );

      const renamed = service.rename("product", product.key, "LIBRARY", write(product));

      expect(renamed.id).toBe(empty.id);
      expect(service.list("product")).toEqual([renamed]);
      expect(service.get("product")).toEqual(renamed);
      expect(service.get("product", "PRODUCT")).toEqual(renamed);
      expect(renamed.data.description).toBe(markdown);
      const connection = ProjectDatabase.open(db.path);
      try {
        expect(new KnowledgeService(connection).get("product")).toEqual(renamed);
      } finally {
        connection.close();
      }
    });
  });

  test("повторное создание заполненного паспорта сохраняет первую запись", () => {
    withKnowledgeFixture((service, db) => {
      const product = service.create("product", { name: "Библиотека" }, "tester");
      const generation = db.getGeneration();

      expectRelayError(
        () => service.create("product", { name: "Вторая копия" }, "tester"),
        "ALREADY_EXISTS",
      );

      expect(service.list("product")).toEqual([product]);
      expect(db.getGeneration()).toBe(generation);
    });
  });

  test.each(validProjectBoundaries)(
    "имя и slug $name принимаются с trim имени",
    ({ input, expectedName }) => {
      withKnowledgeFixture((service) => {
        const project = service.get("project");

        const updated = service.update("project", undefined, input, write(project));

        expect(updated.data.name).toBe(expectedName);
        expect(updated.data.slug).toBe(input.slug);
      });
    },
  );

  test.each(invalidProjectNames)("имя проекта: $name отклоняется без записи", ({ value }) => {
    withKnowledgeFixture((service, db) => {
      const project = service.get("project");
      const generation = db.getGeneration();

      expectRelayError(
        () => service.update("project", project.id, { name: value }, write(project)),
        "INVALID_ARGUMENT",
      );

      expect(service.get("project")).toEqual(project);
      expect(db.getGeneration()).toBe(generation);
    });
  });

  test.each(invalidSlugs)("slug проекта: $name отклоняется без записи", ({ value }) => {
    withKnowledgeFixture((service, db) => {
      const project = service.get("project");
      const generation = db.getGeneration();

      expectRelayError(
        () => service.update("project", project.id, { slug: value }, write(project)),
        "INVALID_ARGUMENT",
      );

      expect(service.get("project")).toEqual(project);
      expect(db.getGeneration()).toBe(generation);
    });
  });
});

describe("Владение доской приложения", () => {
  test.each(invalidSlugs)(
    "slug приложения: $name отклоняется без приложения и доски",
    ({ value }) => {
      withKnowledgeFixture((service, db) => {
        const snapshot = db.list();
        const generation = db.getGeneration();

        expectRelayError(
          () =>
            service.create("application", { name: "Web", slug: value, prefix: "WEB" }, "tester"),
          "INVALID_ARGUMENT",
        );

        expect(db.list()).toEqual(snapshot);
        expect(db.getGeneration()).toBe(generation);
      });
    },
  );

  test.each(applicationSlugBoundaries)(
    "slug приложения длиной $name сохраняется в его доске",
    ({ slug, prefix }) => {
      withKnowledgeFixture((service) => {
        const application = service.create(
          "application",
          { name: "Приложение", slug, prefix },
          "tester",
        );

        const board = service.get("board", application.data.boardId);

        expect(board.data.slug).toBe(slug);
        expect(board.data.applicationId).toBe(application.id);
      });
    },
  );

  test("прямое создание доски отклоняется без изменения состава", () => {
    withKnowledgeFixture((service, db) => {
      const productBoard = service.get("board", "BOARD-PRODUCT");
      const generation = db.getGeneration();

      expectRelayError(
        () =>
          service.create("board", { name: "Обход", slug: "custom", prefix: "CUSTOM" }, "tester"),
        "INVALID_ARGUMENT",
      );

      expect(service.list("board")).toEqual([productBoard]);
      expect(db.getGeneration()).toBe(generation);
    });
  });

  test.each(productBoardFields)(
    "прямая правка %s продуктовой доски отклоняется без записи",
    (field) => {
      withKnowledgeFixture((service, db) => {
        const board = service.get("board", "BOARD-PRODUCT");
        const generation = db.getGeneration();

        expectRelayError(
          () => service.update("board", board.id, { [field]: "Обход" }, write(board)),
          "INVALID_ARGUMENT",
        );

        expect(service.get("board", board.id)).toEqual(board);
        expect(db.getGeneration()).toBe(generation);
      });
    },
  );

  test("прямая правка имени доски приложения отклоняется без изменения владельца", () => {
    withKnowledgeFixture((service, db) => {
      const application = service.create("application", { name: "Web", slug: "web" }, "tester");
      const board = service.get("board", application.data.boardId);
      const generation = db.getGeneration();

      expectRelayError(
        () => service.update("board", board.id, { name: "Чужое имя" }, write(board)),
        "INVALID_ARGUMENT",
      );

      expect(service.get("board", board.id)).toEqual(board);
      expect(service.get("application", application.id)).toEqual(application);
      expect(db.getGeneration()).toBe(generation);
    });
  });

  test("изменение имени приложения атомарно обновляет доску с её собственной ревизией", () => {
    withKnowledgeFixture((service) => {
      const application = service.create("application", { name: "Web", slug: "web" }, "tester");
      const initialBoard = service.get("board", application.data.boardId);
      const renamedBoard = service.rename(
        "board",
        initialBoard.id,
        "FRONTEND-TASKS",
        write(initialBoard),
      );

      const updated = service.update(
        "application",
        application.id,
        { name: "Web-клиент" },
        write(application, "editor"),
      );

      const board = service.get("board", renamedBoard.id);
      expect(updated.data.name).toBe("Web-клиент");
      expect(board.data).toEqual({ ...renamedBoard.data, name: "Web-клиент" });
      expect(board.key).toBe("FRONTEND-TASKS");
      expect(board.revision).toBe(renamedBoard.revision + 1);
      expect(board.updatedBy).toBe("editor");
      expect(service.list("board", { application: application.id })).toEqual([board]);
    });
  });

  test("повтор имени приложения сохраняет обе записи и поколение", () => {
    withKnowledgeFixture((service, db) => {
      const application = service.create("application", { name: "Web", slug: "web" }, "tester");
      const snapshot = db.list();
      const generation = db.getGeneration();

      const unchanged = service.update(
        "application",
        application.id,
        { name: "Web" },
        write(application),
      );

      expect(unchanged).toEqual(application);
      expect(db.list()).toEqual(snapshot);
      expect(db.getGeneration()).toBe(generation);
    });
  });

  test("отказ SQLite на записи доски откатывает имя приложения, обе ревизии и поколение", () => {
    withKnowledgeFixture((service, db) => {
      const application = service.create("application", { name: "Web", slug: "web" }, "tester");
      const snapshot = db.list();
      const generation = db.getGeneration();
      const connection = new Database(db.path, { create: false, readwrite: true });
      try {
        // Триггер прерывает вторую предметную запись после уже записанного имени приложения.
        connection.exec(`
          CREATE TRIGGER knowledge_reject_board_name BEFORE UPDATE ON entities
          WHEN NEW.kind = 'board' AND json_extract(NEW.data, '$.name') = 'Отклонённое имя'
          BEGIN SELECT RAISE(ABORT, 'knowledge board write failure'); END;
        `);

        expectRelayError(
          () =>
            service.update(
              "application",
              application.id,
              { name: "Отклонённое имя" },
              write(application),
            ),
          "CONFLICT",
        );

        expect(db.list()).toEqual(snapshot);
        expect(db.getGeneration()).toBe(generation);
      } finally {
        connection.close();
      }
    });
  });

  test("конфликт ключа доски откатывает новое приложение и счётчик его ключей", () => {
    withKnowledgeFixture((service, db) => {
      const feature = service.create("feature", { name: "Зарезервированный адрес" }, "tester");
      service.rename("feature", feature.key, "BOARD-WEB", write(feature));
      const snapshot = db.list();
      const generation = db.getGeneration();

      expectRelayError(
        () => service.create("application", { name: "Web", slug: "web", prefix: "WEB" }, "tester"),
        "CONFLICT",
      );

      expect(db.list()).toEqual(snapshot);
      expect(db.getGeneration()).toBe(generation);
      const next = service.create("application", { name: "API", slug: "api" }, "tester");
      expect(next.key).toBe("APP-1");
      expect(service.get("board", next.data.boardId).data).toMatchObject({
        applicationId: next.id,
        slug: "api",
        prefix: "API",
      });
    });
  });

  test("переименование приложения сохраняет предметные данные и принадлежность доски", () => {
    withKnowledgeFixture((service) => {
      const application = service.create("application", { name: "API", slug: "api" }, "tester");

      const renamed = service.rename("application", application.key, "API", write(application));

      expect(renamed.data).toEqual(application.data);
      expect(service.get("board", renamed.data.boardId).data.applicationId).toBe(application.id);
    });
  });

  test("изменение slug приложения отклоняется без изменения доски и адресов", () => {
    withKnowledgeFixture((service, db) => {
      const application = service.create("application", { name: "API", slug: "api" }, "tester");
      const snapshot = db.list();
      const generation = db.getGeneration();

      expectRelayError(
        () =>
          service.update("application", application.id, { slug: "different" }, write(application)),
        "INVALID_ARGUMENT",
      );

      expect(db.list()).toEqual(snapshot);
      expect(db.getGeneration()).toBe(generation);
    });
  });

  test("подмена владельца доски отклоняется без изменения записей", () => {
    withKnowledgeFixture((service, db) => {
      const application = service.create("application", { name: "Web", slug: "web" }, "tester");
      const board = service.get("board", application.data.boardId);
      const feature = service.create("feature", { name: "Чужой владелец" }, "tester");
      const snapshot = db.list();
      const generation = db.getGeneration();

      expectRelayError(
        () => service.update("board", board.id, { applicationId: feature.id }, write(board)),
        "INVALID_ARGUMENT",
      );

      expect(db.list()).toEqual(snapshot);
      expect(db.getGeneration()).toBe(generation);
    });
  });
});

describe("Ключи, алиасы и виртуальные адреса знаний", () => {
  test.each(reservedAddresses)(
    "ключ $kind не перехватывает чужой адрес $address",
    ({ kind, address }) => {
      withKnowledgeFixture((service, db) => {
        const web = service.create("application", { name: "Web", slug: "web" }, "tester");
        if (address === "api" || address === "API") {
          service.create("application", { name: "API", slug: "api" }, "tester");
        }
        const entity = kind === "application" ? web : service.get("board", web.data.boardId);
        const snapshot = db.list();
        const generation = db.getGeneration();

        expectRelayError(() => service.rename(kind, entity.id, address, write(entity)), "CONFLICT");

        expect(db.list()).toEqual(snapshot);
        expect(db.getGeneration()).toBe(generation);
      });
    },
  );

  test.each(productBoardAddresses)(
    "адрес %s выбирает продуктовую доску при создании задачи",
    (address) => {
      withKnowledgeFixture((service, db) => {
        const board = service.get("board", "product");
        const tasks = new TasksService(db);

        const task = tasks.create({ board: address, title: "Работа продукта" }, "tester");

        expect(task.data.boardId).toBe(board.id);
        expect(task.key).toStartWith("PRODUCT-");
      });
    },
  );

  test("slug выбирает приложение для участия, сохраняя пустой состав другого приложения", () => {
    withKnowledgeFixture((service) => {
      const web = service.create("application", { name: "Web", slug: "web" }, "tester");
      const api = service.create("application", { name: "API", slug: "api" }, "tester");
      const feature = service.create("feature", { name: "Поиск" }, "tester");

      const selected = service.replaceParticipation("api", [feature.id], write(api));

      expect(selected.id).toBe(api.id);
      expect(service.list("implementation", { application: web.id })).toEqual([]);
      expect(service.list("implementation", { application: api.id })).toMatchObject([
        { data: { targetId: feature.id, applicationId: api.id } },
      ]);
    });
  });

  for (const kind of addressOwners) {
    test.each(addressReservations)(
      `создание приложения не перехватывает ${kind}: $name`,
      ({ address, slug, prefix, retired }) => {
        withKnowledgeFixture((service, db) => {
          const owner = service.create("application", { name: "Web", slug: "web" }, "tester");
          const initial = kind === "application" ? owner : service.get("board", owner.data.boardId);
          let entity = service.rename(kind, initial.id, address, write(initial));
          if (retired) {
            entity = service.rename(kind, entity.id, `OWNER-${address}`, write(entity));
          }
          const snapshot = db.list();
          const generation = db.getGeneration();

          expectRelayError(
            () =>
              service.create("application", { name: "Новое приложение", slug, prefix }, "tester"),
            "CONFLICT",
          );

          expect(db.list()).toEqual(snapshot);
          expect(db.getGeneration()).toBe(generation);
          expect(service.get(kind, address).id).toBe(entity.id);
          const next = service.create("application", { name: "API", slug: "api" }, "tester");
          expect(next.key).toBe("APP-2");
          expect(service.list("board")).toHaveLength(3);
        });
      },
    );
  }

  test.each(addressOwners)(
    "последовательное переименование %s сохраняет собственные адреса и алиасы",
    (kind) => {
      withKnowledgeFixture((service) => {
        const application = service.create("application", { name: "Web", slug: "web" }, "tester");
        let entity =
          kind === "application" ? application : service.get("board", application.data.boardId);
        const originalKey = entity.key;

        // Это одна цепочка возврата собственных адресов, а не независимые варианты ввода.
        for (const key of ["web", "WEB", "OTHER", "web", originalKey]) {
          entity = service.rename(kind, entity.id, key, write(entity));

          for (const address of ["web", "WEB", originalKey, entity.id]) {
            expect(service.get(kind, address)).toEqual(entity);
            expect(service.get(kind, `${kind}:${address}`)).toEqual(entity);
          }
        }
      });
    },
  );

  test.each(addressOwners)("повтор ключа %s сохраняет ревизию и поколение", (kind) => {
    withKnowledgeFixture((service, db) => {
      const application = service.create("application", { name: "Web", slug: "web" }, "tester");
      const entity =
        kind === "application" ? application : service.get("board", application.data.boardId);
      const generation = db.getGeneration();

      const unchanged = service.rename(kind, entity.id, entity.key, write(entity));

      expect(unchanged).toEqual(entity);
      expect(service.get(kind, entity.id)).toEqual(entity);
      expect(db.getGeneration()).toBe(generation);
    });
  });

  test("генерация ключа приложения пропускает занятый чужим prefix адрес", () => {
    withKnowledgeFixture((service) => {
      const application = service.create(
        "application",
        { name: "Web", slug: "web", prefix: "APP-2" },
        "tester",
      );

      const next = service.create("application", { name: "API", slug: "api" }, "tester");

      expect(next.key).toBe("APP-3");
      expect(service.get("application", "APP-2").id).toBe(application.id);
      expect(service.get("application", next.key).id).toBe(next.id);
    });
  });

  test("конфликт ключа новой доски с prefix откатывает приложение, поколение и счётчик", () => {
    withKnowledgeFixture((service, db) => {
      const application = service.create(
        "application",
        { name: "Web", slug: "web", prefix: "BOARD-API" },
        "tester",
      );
      const snapshot = db.list();
      const generation = db.getGeneration();

      expectRelayError(
        () => service.create("application", { name: "API", slug: "api" }, "tester"),
        "CONFLICT",
      );

      expect(db.list()).toEqual(snapshot);
      expect(db.getGeneration()).toBe(generation);
      expect(service.get("board", "BOARD-API").id).toBe(application.data.boardId);
      expect(service.create("application", { name: "CLI", slug: "cli" }, "tester").key).toBe(
        "APP-2",
      );
    });
  });
});

describe("Типизированные ссылки между предметными областями", () => {
  test.each(documentAddressGuards)(
    "%s не позволяет перехватить типизированную цель документа ключом",
    (boundary) => {
      withKnowledgeFixture((service, db) => {
        const feature = service.create("feature", { name: "Поиск" }, "tester");
        const other = service.create("feature", { name: "Другая фича" }, "tester");
        const target = `feature:${feature.key}`;
        const snapshot = db.list();
        const generation = db.getGeneration();

        expectRelayError(() => {
          if (boundary === "KnowledgeService") {
            return service.rename("feature", other.id, target, write(other));
          }
          // Намеренный обход предметного API не должен создавать неоднозначный адрес.
          return db.rename(other.id, target, other.revision, "tester");
        }, "VALIDATION_ERROR");

        expect(db.list()).toEqual(snapshot);
        expect(db.getGeneration()).toBe(generation);
        expect(service.get("feature", target)).toEqual(feature);
      });
    },
  );

  test("типизированные ключ и ID связывают документ с той же целью при создании и правке", () => {
    withKnowledgeFixture((service) => {
      const feature = service.create("feature", { name: "Поиск" }, "tester");
      const other = service.create("feature", { name: "Другая фича" }, "tester");
      const target = `feature:${feature.key}`;
      const document = service.create(
        "document",
        { name: "Материал", body: "Текст", targets: [target] },
        "tester",
      );

      const linked = service.linkDocument(`document:${document.id}`, `feature:${feature.id}`, {
        ...write(document),
        type: "references",
      });

      expect(document.data.relations).toEqual([
        { target: { kind: "feature", id: feature.id }, type: "documents", description: "" },
      ]);
      expect(linked.data.relations).toEqual([
        { target: { kind: "feature", id: feature.id }, type: "documents", description: "" },
        { target: { kind: "feature", id: feature.id }, type: "references", description: "" },
      ]);
      expect(service.list("document", { target })).toEqual([linked]);
      expect(service.list("document", { target: other.id })).toEqual([]);
    });
  });

  test("чтение документа по типизированной ссылке фичи даёт INVALID_ARGUMENT", () => {
    withKnowledgeFixture((service) => {
      const feature = service.create("feature", { name: "Поиск" }, "tester");

      expectRelayError(() => service.get("document", `feature:${feature.key}`), "INVALID_ARGUMENT");
    });
  });

  test("типизированная цель задачи сохраняется как ID и задача читается по task:ID", () => {
    withKnowledgeFixture((service, db) => {
      const feature = service.create("feature", { name: "Поиск" }, "tester");
      const tasks = new TasksService(db);

      const task = tasks.create(
        { title: "Реализовать поиск", targets: [`feature:${feature.key}`] },
        "tester",
      );

      expect(task.data.targets).toEqual([feature.id]);
      expect(tasks.get(`task:${task.id}`)).toEqual(task);
    });
  });

  test("типизированная область плана разрешается в ID и план читается по work-plan:ключ", () => {
    withKnowledgeFixture((service, db) => {
      const feature = service.create("feature", { name: "Поиск" }, "tester");
      const planning = new PlanningService(db);

      const plan = planning.create(
        "work-plan",
        {
          title: "План поиска",
          goal: "Дать пользователю поиск",
          scope: [{ kind: "feature", id: `feature:${feature.id}` }],
        },
        "tester",
      );

      expect(plan.data.scope).toEqual([{ kind: "feature", id: feature.id }]);
      expect(planning.get("work-plan", `work-plan:${plan.key}`)).toEqual(plan);
    });
  });

  test("типизированная ссылка плана в релизе сохраняется как постоянный ID", () => {
    withKnowledgeFixture((_service, db) => {
      const planning = new PlanningService(db);
      const plan = planning.create("work-plan", { title: "План", goal: "Результат" }, "tester");

      const release = planning.create(
        "release",
        { title: "Выпуск", version: "1.0.0", planIds: [`work-plan:${plan.id}`] },
        "tester",
      );

      expect(release.data.planIds).toEqual([plan.id]);
    });
  });

  test("чтение задачи с явным видом feature отклоняется без записи", () => {
    withKnowledgeFixture((_service, db) => {
      const tasks = new TasksService(db);
      const task = tasks.create({ title: "Работа" }, "tester");
      const generation = db.getGeneration();

      expectRelayError(() => tasks.get(`feature:${task.id}`), "INVALID_ARGUMENT");

      expect(tasks.get(task.id)).toEqual(task);
      expect(db.getGeneration()).toBe(generation);
    });
  });

  test("чтение плана с явным видом release отклоняется без записи", () => {
    withKnowledgeFixture((_service, db) => {
      const planning = new PlanningService(db);
      const plan = planning.create("work-plan", { title: "План" }, "tester");
      const generation = db.getGeneration();

      expectRelayError(() => planning.get("work-plan", `release:${plan.id}`), "INVALID_ARGUMENT");

      expect(planning.get("work-plan", plan.id)).toEqual(plan);
      expect(db.getGeneration()).toBe(generation);
    });
  });
});

describe("Реализации фич и сценариев", () => {
  test("создание SI без FI отклоняется без изменения приложения", () => {
    withKnowledgeFixture((service, db) => {
      const { scenario, application } = createKnowledgeRequirements(service);
      const snapshot = db.list();
      const generation = db.getGeneration();

      expectRelayError(
        () =>
          service.create(
            "implementation",
            { application: application.key, target: scenario.key, title: "SI" },
            "tester",
          ),
        "INVALID_ARGUMENT",
      );

      expect(db.list()).toEqual(snapshot);
      expect(db.getGeneration()).toBe(generation);
    });
  });

  test("FI другого приложения не разрешает создание SI и не меняет состав", () => {
    withKnowledgeFixture((service, db) => {
      const { feature, scenario, application } = createKnowledgeRequirements(service);
      service.create(
        "implementation",
        { application: application.id, target: feature.id, title: "FI" },
        "tester",
      );
      const another = service.create("application", { name: "API", slug: "api" }, "tester");
      const snapshot = db.list();
      const generation = db.getGeneration();

      expectRelayError(
        () =>
          service.create(
            "implementation",
            { application: another.key, target: scenario.key, title: "SI" },
            "tester",
          ),
        "INVALID_ARGUMENT",
      );

      expect(db.list()).toEqual(snapshot);
      expect(db.getGeneration()).toBe(generation);
    });
  });

  test("переименование фичи сохраняет постоянные ссылки сценария, FI и SI", () => {
    withKnowledgeFixture((service) => {
      const { feature, scenario, application } = createKnowledgeRequirements(service);
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
      const si = service.create(
        "implementation",
        { application: application.key, target: scenario.id, title: "Поиск по имени" },
        "tester",
      );

      const renamed = service.rename("feature", feature.key, "SEARCH", write(feature));

      expect(service.get("scenario", scenario.key).data.featureId).toBe(feature.id);
      expect(service.get("implementation", fi.key).data.targetId).toBe(renamed.id);
      expect(service.get("implementation", si.key).data).toMatchObject({
        featureId: renamed.id,
        scenarioId: scenario.id,
      });
      expect(
        service
          .list("implementation", { application: application.key, feature: "SEARCH" })
          .map((item) => item.id)
          .sort(),
      ).toEqual([fi.id, si.id].sort());
    });
  });

  test("повтор FI той же цели даёт ALREADY_EXISTS без изменения участия", () => {
    withKnowledgeFixture((service, db) => {
      const feature = service.create("feature", { name: "Фича" }, "tester");
      const application = service.create("application", { name: "Web", slug: "web" }, "tester");
      service.create(
        "implementation",
        { application: application.id, target: feature.id, title: "FI" },
        "tester",
      );
      const snapshot = db.list();
      const generation = db.getGeneration();

      expectRelayError(
        () =>
          service.create(
            "implementation",
            { application: application.key, target: feature.key, title: "Дубликат" },
            "tester",
          ),
        "ALREADY_EXISTS",
      );

      expect(db.list()).toEqual(snapshot);
      expect(db.getGeneration()).toBe(generation);
    });
  });

  test("чужая реализация не принимается в состав приложения без изменения обоих владельцев", () => {
    withKnowledgeFixture((service, db) => {
      const feature = service.create("feature", { name: "Фича" }, "tester");
      const owner = service.create("application", { name: "Web", slug: "web" }, "tester");
      const implementation = service.create(
        "implementation",
        { application: owner.id, target: feature.id, title: "FI" },
        "tester",
      );
      const another = service.create("application", { name: "API", slug: "api" }, "tester");
      const snapshot = db.list();
      const generation = db.getGeneration();

      expectRelayError(
        () => service.replaceParticipation(another.id, [implementation.id], write(another)),
        "INVALID_ARGUMENT",
      );

      expect(db.list()).toEqual(snapshot);
      expect(db.getGeneration()).toBe(generation);
    });
  });
});

describe("Замена участия приложения", () => {
  test("повтор пустого участия сохраняет ревизию приложения и поколение", () => {
    withKnowledgeFixture((service, db) => {
      const application = service.create("application", { name: "Web", slug: "web" }, "tester");
      const generation = db.getGeneration();

      const unchanged = service.replaceParticipation(application.id, [], write(application));

      expect(unchanged).toEqual(application);
      expect(db.getGeneration()).toBe(generation);
    });
  });

  test("тот же состав по ID и ключам реализаций сохраняет записи и поколение", () => {
    withKnowledgeFixture((service, db) => {
      const { application, featureImplementation, scenarioImplementation } =
        createKnowledgeParticipation(service);
      const snapshot = db.list();
      const generation = db.getGeneration();

      const unchanged = service.replaceParticipation(
        application.id,
        [featureImplementation.id, scenarioImplementation.key],
        write(application),
      );

      expect(unchanged).toEqual(application);
      expect(db.list()).toEqual(snapshot);
      expect(db.getGeneration()).toBe(generation);
    });
  });

  test.each(invalidParticipation)(
    "состав: $name отклоняется целиком без изменения участия",
    ({ targets, code }) => {
      withKnowledgeFixture((service, db) => {
        const { feature, scenario, application } = createKnowledgeParticipation(service);
        let invalidTargets: string[];
        switch (targets) {
          case "scenario":
            invalidTargets = [scenario.key];
            break;
          case "missing":
            invalidTargets = [feature.key, "UNKNOWN"];
            break;
          case "duplicate":
            invalidTargets = [feature.key, feature.id];
            break;
        }
        const snapshot = db.list();
        const generation = db.getGeneration();

        expectRelayError(
          () => service.replaceParticipation(application.key, invalidTargets, write(application)),
          code,
        );

        expect(db.list()).toEqual(snapshot);
        expect(db.getGeneration()).toBe(generation);
      });
    },
  );

  test("документ вместо требования отклоняется без изменения участия приложения", () => {
    withKnowledgeFixture((service, db) => {
      const { application } = createKnowledgeParticipation(service);
      const document = service.create("document", { name: "Материал", body: "Текст" }, "tester");
      const snapshot = db.list();
      const generation = db.getGeneration();

      expectRelayError(
        () => service.replaceParticipation(application.key, [document.key], write(application)),
        "INVALID_ARGUMENT",
      );

      expect(db.list()).toEqual(snapshot);
      expect(db.getGeneration()).toBe(generation);
    });
  });

  test("снятие, редактирование и возврат участия сохраняют ID, ключи, текст и существующие связи", () => {
    withKnowledgeFixture((service) => {
      const {
        application,
        featureImplementation: fi,
        scenarioImplementation,
      } = createKnowledgeParticipation(service);
      const si = service.update(
        "implementation",
        scenarioImplementation.id,
        {
          title: "Собственный вклад",
          description: "## Поведение\n\nТекст сохраняется.\n",
          status: "done",
        },
        write(scenarioImplementation),
      );
      const document = service.create(
        "document",
        {
          name: "Материалы",
          body: "Полный текст",
          relations: [{ target: si.key, type: "references", description: "Основание" }],
        },
        "tester",
      );

      const inactive = service.replaceParticipation(application.key, [], write(application));

      expect(service.list("implementation", { active: true })).toEqual([]);
      expect(service.get("implementation", fi.key).data.active).toBe(false);
      const inactiveSi = service.get("implementation", si.key);
      expect(inactiveSi).toMatchObject({
        id: si.id,
        key: si.key,
        data: { ...si.data, active: false },
      });
      expect(service.get("document", document.id).data.relations).toEqual(document.data.relations);
      const linked = service.linkDocument(document.key, si.key, {
        ...write(document),
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
      expect(service.get("implementation", si.key)).toMatchObject({
        id: si.id,
        key: si.key,
        data: { ...edited.data, active: true },
      });
      expect(service.get("document", linked.id).data.relations).toEqual(linked.data.relations);
      expect(service.list("implementation")).toHaveLength(2);
    });
  });

  test("новая связь со снятой реализацией отклоняется без изменения документа", () => {
    withKnowledgeFixture((service, db) => {
      const { application, scenarioImplementation } = createKnowledgeParticipation(service);
      const document = service.create(
        "document",
        {
          name: "Материалы",
          body: "Текст",
          relations: [{ target: scenarioImplementation.key, type: "references" }],
        },
        "tester",
      );
      service.replaceParticipation(application.id, [], write(application));
      const snapshot = db.list();
      const generation = db.getGeneration();

      expectRelayError(
        () =>
          service.linkDocument(document.key, scenarioImplementation.key, {
            ...write(document),
            type: "documents",
          }),
        "INVALID_ARGUMENT",
      );

      expect(db.list()).toEqual(snapshot);
      expect(db.getGeneration()).toBe(generation);
    });
  });

  test("поздний отказ состава откатывает внешнюю транзакцию с уже созданными FI и SI", () => {
    withKnowledgeFixture((service, db) => {
      const { feature, scenario, application } = createKnowledgeRequirements(service);
      const snapshot = db.list();
      const generation = db.getGeneration();

      expectRelayError(
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
    });
  });
});

describe("Разделы документов", () => {
  test("проект без разделов возвращает пустой состав и свою ревизию", () => {
    withKnowledgeFixture((service) => {
      const project = service.get("project");

      const sections = service.documentSections();

      expect(sections).toEqual({ project: project.key, revision: project.revision, items: [] });
    });
  });

  test("созданный раздел возвращается с ревизией проекта-владельца", () => {
    withKnowledgeFixture((service) => {
      const project = service.changeSection(
        "create",
        { id: "guides", name: "Руководства" },
        write(service.get("project")),
      );

      const sections = service.documentSections();

      expect(sections).toEqual({
        project: project.key,
        revision: project.revision,
        items: [{ id: "guides", name: "Руководства" }],
      });
    });
  });

  test.each(sectionMoves)(
    "перемещение $name меняет порядок, сохраняя ID и имена разделов",
    ({ initialSections, before, expected }) => {
      withKnowledgeFixture((service) => {
        let project = service.get("project");
        for (const section of initialSections) {
          project = service.changeSection("create", { ...section }, write(project));
        }

        const moved = service.changeSection("move", { id: "rules", before }, write(project));

        expect(moved.data.documentSections).toEqual([...expected]);
      });
    },
  );

  test("переименование раздела сохраняет его ID и положение", () => {
    withKnowledgeFixture((service) => {
      const project = service.changeSection(
        "create",
        { id: "guides", name: "Руководства" },
        write(service.get("project")),
      );

      const updated = service.changeSection(
        "update",
        { id: "guides", name: "Инструкции" },
        write(project),
      );

      expect(updated.data.documentSections).toEqual([{ id: "guides", name: "Инструкции" }]);
    });
  });

  test("удаление раздела проецирует null без переписывания документа и его метаданных", () => {
    withKnowledgeFixture((service, db) => {
      const project = service.changeSection(
        "create",
        { id: "guides", name: "Руководства" },
        write(service.get("project")),
      );
      const document = service.create(
        "document",
        { name: "Как искать", body: "# Поиск\n\nПоследний абзац.\n", sectionId: "guides" },
        "tester",
      );

      service.changeSection("remove", { id: "guides" }, write(project));

      const effective = service.get("document", document.key);
      expect(effective).toEqual({ ...document, data: { ...document.data, sectionId: null } });
      expect(db.get(document.id)).toEqual(document);
      expect(service.list("document", { section: "none" })).toEqual([effective]);
    });
  });

  test("ID удалённого раздела не переиспользуется и сохраняет проект без записи", () => {
    withKnowledgeFixture((service, db) => {
      const created = service.changeSection(
        "create",
        { id: "guides", name: "Руководства" },
        write(service.get("project")),
      );
      const removed = service.changeSection("remove", { id: "guides" }, write(created));
      const generation = db.getGeneration();

      expectRelayError(
        () =>
          service.changeSection("create", { id: "guides", name: "Другой раздел" }, write(removed)),
        "ALREADY_EXISTS",
      );

      expect(service.get("project")).toEqual(removed);
      expect(db.getGeneration()).toBe(generation);
    });
  });

  test("перемещение раздела перед собой отклоняется без изменения порядка и ревизии", () => {
    withKnowledgeFixture((service, db) => {
      const project = service.changeSection(
        "create",
        { id: "rules", name: "Правила" },
        write(service.get("project")),
      );
      const generation = db.getGeneration();

      expectRelayError(
        () => service.changeSection("move", { id: "rules", before: "rules" }, write(project)),
        "INVALID_ARGUMENT",
      );

      expect(service.get("project")).toEqual(project);
      expect(db.getGeneration()).toBe(generation);
    });
  });

  test("явное назначение удалённого раздела отклоняется без изменения документа", () => {
    withKnowledgeFixture((service, db) => {
      const project = service.changeSection(
        "create",
        { id: "guides", name: "Руководства" },
        write(service.get("project")),
      );
      const document = service.create(
        "document",
        { name: "Документ", body: "Текст", sectionId: "guides" },
        "tester",
      );
      service.changeSection("remove", { id: "guides" }, write(project));
      const generation = db.getGeneration();

      expectRelayError(
        () => service.update("document", document.id, { sectionId: "guides" }, write(document)),
        "NOT_FOUND",
      );

      expect(db.get(document.id)).toEqual(document);
      expect(db.getGeneration()).toBe(generation);
    });
  });

  test("несвязанная правка документа сохраняет удалённый ID в хранении и null в проекции", () => {
    withKnowledgeFixture((service, db) => {
      const project = service.changeSection(
        "create",
        { id: "guides", name: "Руководства" },
        write(service.get("project")),
      );
      const document = service.create(
        "document",
        { name: "Документ", body: "Текст", sectionId: "guides" },
        "tester",
      );
      service.changeSection("remove", { id: "guides" }, write(project));

      const updated = service.update(
        "document",
        document.id,
        { summary: "Новая аннотация" },
        write(document),
      );

      expect(updated.data).toMatchObject({ summary: "Новая аннотация", sectionId: null });
      expect(db.get(document.id)?.data.sectionId).toBe("guides");
    });
  });
});

describe("Связи документов", () => {
  test("чтение связей возвращает проверенные цели и ревизию документа", () => {
    withKnowledgeFixture((service) => {
      const feature = service.create("feature", { name: "Поиск" }, "tester");
      const document = service.create(
        "document",
        { name: "Инструкция", body: "Текст", targets: [feature.id] },
        "tester",
      );

      const links = service.documentLinks(document.key);

      expect(links).toEqual({
        ref: document.key,
        revision: document.revision,
        items: [
          { target: { kind: "feature", id: feature.id }, type: "documents", description: "" },
        ],
      });
    });
  });

  test("два типа связи сохраняют полные пояснения и находятся по переименованной цели", () => {
    withKnowledgeFixture((service) => {
      const feature = service.create("feature", { name: "Поиск" }, "tester");
      const document = service.create(
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
      const documented = service.linkDocument(document.key, feature.key, {
        ...write(document),
        type: "documents",
        description,
      });
      const linked = service.linkDocument(document.key, feature.id, {
        ...write(documented),
        type: "references",
        description: "Другое отношение",
      });
      const renamed = service.rename("feature", feature.id, "LOOKUP", write(feature));

      const documents = service.list("document", {
        target: renamed.key,
        pinned: true,
        documentKind: "research",
        status: "active",
      });

      expect(documents).toEqual([linked]);
      expect(linked.data.relations).toEqual([
        { target: { kind: "feature", id: feature.id }, type: "documents", description },
        {
          target: { kind: "feature", id: feature.id },
          type: "references",
          description: "Другое отношение",
        },
      ]);
      expect(service.get("feature", feature.key).key).toBe("LOOKUP");
    });
  });

  test.each(invalidRelationInputs)(
    "отношение: $name отклоняется без изменения документа",
    ({ input }) => {
      withKnowledgeFixture((service, db) => {
        const feature = service.create("feature", { name: "Поиск" }, "tester");
        const document = service.create(
          "document",
          { name: "Материал", body: "Текст", targets: [feature.key] },
          "tester",
        );
        const generation = db.getGeneration();

        expectRelayError(() => {
          switch (input) {
            case "duplicate":
              return service.update(
                "document",
                document.id,
                {
                  relations: [
                    { target: feature.key },
                    { target: { kind: "feature", id: feature.id } },
                  ],
                },
                write(document),
              );
            case "unknown-field":
              return service.update(
                "document",
                document.id,
                { relations: [{ target: feature.key, typo: true }] },
                write(document),
              );
            case "kind-mismatch":
              return service.update(
                "document",
                document.id,
                { relations: [{ target: { kind: "document", id: `feature:${feature.key}` } }] },
                write(document),
              );
          }
        }, "INVALID_ARGUMENT");

        expect(service.get("document", document.id)).toEqual(document);
        expect(db.getGeneration()).toBe(generation);
      });
    },
  );

  test("ссылка документа на себя отклоняется без изменения отношений", () => {
    withKnowledgeFixture((service, db) => {
      const document = service.create("document", { name: "Материал", body: "Текст" }, "tester");
      const generation = db.getGeneration();

      expectRelayError(
        () => service.linkDocument(document.key, document.id, write(document)),
        "INVALID_ARGUMENT",
      );

      expect(service.get("document", document.id)).toEqual(document);
      expect(db.getGeneration()).toBe(generation);
    });
  });

  test("открепление одной пары цель и тип сохраняет другое отношение к той же цели", () => {
    withKnowledgeFixture((service) => {
      const feature = service.create("feature", { name: "Поиск" }, "tester");
      const document = service.create(
        "document",
        {
          name: "Материал",
          body: "Текст",
          relations: [
            { target: feature.key, type: "documents", description: "Полное основание 🧭.\n" },
            { target: feature.id, type: "references", description: "Другое отношение" },
          ],
        },
        "tester",
      );

      const unlinked = service.linkDocument(document.key, feature.key, {
        ...write(document),
        remove: true,
        type: "references",
      });

      expect(unlinked.data.relations).toEqual([
        {
          target: { kind: "feature", id: feature.id },
          type: "documents",
          description: "Полное основание 🧭.\n",
        },
      ]);
    });
  });

  test("повтор существующей связи без описания сохраняет её текст, ревизию и поколение", () => {
    withKnowledgeFixture((service, db) => {
      const feature = service.create("feature", { name: "Поиск" }, "tester");
      const document = service.create(
        "document",
        {
          name: "Материал",
          body: "Текст",
          relations: [{ target: feature.key, description: "Сохранённое основание" }],
        },
        "tester",
      );
      const generation = db.getGeneration();

      const unchanged = service.linkDocument(document.key, feature.key, write(document));

      expect(unchanged).toEqual(document);
      expect(db.getGeneration()).toBe(generation);
    });
  });
});

describe("Исходная ревизия знаний при конкурентной записи", () => {
  test.each(featureRevisionOperations)(
    "%s: устаревшая ревизия до no-op сохраняет запись другого соединения",
    (operation) => {
      withKnowledgeFixture((service, db) => {
        const initial = service.create("feature", { name: "Поиск" }, "tester");
        const connection = ProjectDatabase.open(db.path);
        try {
          const second = new KnowledgeService(connection);
          const current = second.update(
            "feature",
            initial.id,
            { name: "Новый поиск" },
            write(initial),
          );
          const generation = db.getGeneration();

          expectRelayError(() => {
            if (operation === "update") {
              return service.update("feature", initial.id, { name: "Новый поиск" }, write(initial));
            }
            return service.rename("feature", initial.id, initial.key, write(initial));
          }, "REVISION_CONFLICT");

          expect(service.get("feature", initial.id)).toEqual(current);
          expect(db.getGeneration()).toBe(generation);
        } finally {
          connection.close();
        }
      });
    },
  );

  test("устаревшая ревизия документа отклоняет повтор связи после чужого commit", () => {
    withKnowledgeFixture((service, db) => {
      const feature = service.create("feature", { name: "Поиск" }, "tester");
      const initial = service.create("document", { name: "Материал", body: "Текст" }, "tester");
      const connection = ProjectDatabase.open(db.path);
      try {
        const linked = new KnowledgeService(connection).linkDocument(
          initial.id,
          feature.id,
          write(initial),
        );
        const generation = db.getGeneration();

        expectRelayError(
          () => service.linkDocument(initial.id, feature.id, write(initial)),
          "REVISION_CONFLICT",
        );

        expect(service.get("document", initial.id)).toEqual(linked);
        expect(db.getGeneration()).toBe(generation);
      } finally {
        connection.close();
      }
    });
  });

  test("повтор связи с актуальной ревизией после чужого commit остаётся no-op", () => {
    withKnowledgeFixture((service, db) => {
      const feature = service.create("feature", { name: "Поиск" }, "tester");
      const initial = service.create("document", { name: "Материал", body: "Текст" }, "tester");
      const connection = ProjectDatabase.open(db.path);
      try {
        const linked = new KnowledgeService(connection).linkDocument(
          initial.id,
          feature.id,
          write(initial),
        );
        const generation = db.getGeneration();

        const unchanged = service.linkDocument(initial.id, feature.id, write(linked));

        expect(unchanged).toEqual(linked);
        expect(db.getGeneration()).toBe(generation);
      } finally {
        connection.close();
      }
    });
  });

  test("устаревшая ревизия приложения отклоняет повтор состава после чужого commit", () => {
    withKnowledgeFixture((service, db) => {
      const { feature, scenario, application } = createKnowledgeRequirements(service);
      const connection = ProjectDatabase.open(db.path);
      try {
        new KnowledgeService(connection).replaceParticipation(
          application.id,
          [feature.id, scenario.id],
          write(application),
        );
        const featureImplementation = service.list("implementation", { target: feature.id })[0];
        const scenarioImplementation = service.list("implementation", { target: scenario.id })[0];
        if (!featureImplementation || !scenarioImplementation) {
          throw new Error("Подготовка чужого commit не создала FI и SI");
        }
        const snapshot = db.list();
        const generation = db.getGeneration();

        expectRelayError(
          () =>
            service.replaceParticipation(
              application.id,
              [featureImplementation.id, scenarioImplementation.key],
              write(application),
            ),
          "REVISION_CONFLICT",
        );

        expect(db.list()).toEqual(snapshot);
        expect(db.getGeneration()).toBe(generation);
      } finally {
        connection.close();
      }
    });
  });

  test("устаревшая ревизия проекта отклоняет повтор имени раздела после чужого commit", () => {
    withKnowledgeFixture((service, db) => {
      const initial = service.get("project");
      const connection = ProjectDatabase.open(db.path);
      try {
        const current = new KnowledgeService(connection).changeSection(
          "create",
          { id: "rules", name: "Правила" },
          write(initial),
        );
        const generation = db.getGeneration();

        expectRelayError(
          () => service.changeSection("update", { id: "rules", name: "Правила" }, write(initial)),
          "REVISION_CONFLICT",
        );

        expect(service.get("project")).toEqual(current);
        expect(db.getGeneration()).toBe(generation);
      } finally {
        connection.close();
      }
    });
  });
});

describe("Владельцы полей и валидация публичных операций знаний", () => {
  test.each(foreignKindOperations)("%s чужого вида отклоняется без записи", (operation) => {
    withKnowledgeFixture((service, db) => {
      const feature = service.create("feature", { name: "Фича" }, "tester");
      const snapshot = db.list();
      const generation = db.getGeneration();

      expectRelayError(() => {
        switch (operation) {
          case "create":
            return service.create("task", { name: "Обход" }, "tester");
          case "get":
            return service.get("work-plan", feature.id);
          case "list":
            return service.list("release");
          case "update":
            return service.update("task", feature.id, {}, write(feature));
          case "rename":
            return service.rename("work-checkpoint", feature.id, "OTHER", write(feature));
        }
      }, "INVALID_ARGUMENT");

      expect(db.list()).toEqual(snapshot);
      expect(db.getGeneration()).toBe(generation);
    });
  });

  test.each(invalidFeatureInputs)("фича: $name отклоняется без создания записи", ({ input }) => {
    withKnowledgeFixture((service, db) => {
      const generation = db.getGeneration();

      expectRelayError(() => service.create("feature", input, "tester"), "INVALID_ARGUMENT");

      expect(service.list("feature")).toEqual([]);
      expect(db.getGeneration()).toBe(generation);
    });
  });

  test.each(invalidDocumentInputs)(
    "документ: $name отклоняется без создания записи",
    ({ input }) => {
      withKnowledgeFixture((service, db) => {
        const generation = db.getGeneration();

        expectRelayError(() => service.create("document", input, "tester"), "INVALID_ARGUMENT");

        expect(service.list("document")).toEqual([]);
        expect(db.getGeneration()).toBe(generation);
      });
    },
  );

  test("одновременные feature и featureId при создании сценария отклоняются без записи", () => {
    withKnowledgeFixture((service, db) => {
      const feature = service.create("feature", { name: "Фича" }, "tester");
      const generation = db.getGeneration();

      expectRelayError(
        () =>
          service.create(
            "scenario",
            { name: "Сценарий", feature: feature.id, featureId: feature.id },
            "tester",
          ),
        "INVALID_ARGUMENT",
      );

      expect(service.list("scenario")).toEqual([]);
      expect(db.getGeneration()).toBe(generation);
    });
  });

  test.each(immutableScenarioFields)(
    "прямая правка %s сценария отклоняется без изменения связи",
    (field) => {
      withKnowledgeFixture((service, db) => {
        const feature = service.create("feature", { name: "Фича" }, "tester");
        const scenario = service.create(
          "scenario",
          { name: "Сценарий", feature: feature.id },
          "tester",
        );
        const generation = db.getGeneration();

        expectRelayError(
          () => service.update("scenario", scenario.id, { [field]: feature.id }, write(scenario)),
          "INVALID_ARGUMENT",
        );

        expect(service.get("scenario", scenario.id)).toEqual(scenario);
        expect(db.getGeneration()).toBe(generation);
      });
    },
  );

  test("прямая правка active реализации отклоняется без изменения участия", () => {
    withKnowledgeFixture((service, db) => {
      const feature = service.create("feature", { name: "Фича" }, "tester");
      const application = service.create("application", { name: "Web", slug: "web" }, "tester");
      const implementation = service.create(
        "implementation",
        { application: application.id, target: feature.id, title: "FI" },
        "tester",
      );
      const snapshot = db.list();
      const generation = db.getGeneration();

      expectRelayError(
        () =>
          service.update(
            "implementation",
            implementation.id,
            { active: false },
            write(implementation),
          ),
        "INVALID_ARGUMENT",
      );

      expect(db.list()).toEqual(snapshot);
      expect(db.getGeneration()).toBe(generation);
    });
  });

  test("прямая замена implementationIds приложения отклоняется без изменения владельца", () => {
    withKnowledgeFixture((service, db) => {
      const application = service.create("application", { name: "Web", slug: "web" }, "tester");
      const generation = db.getGeneration();

      expectRelayError(
        () =>
          service.update(
            "application",
            application.id,
            { implementationIds: [] },
            write(application),
          ),
        "INVALID_ARGUMENT",
      );

      expect(service.get("application", application.id)).toEqual(application);
      expect(db.getGeneration()).toBe(generation);
    });
  });

  test("прямая замена documentSections проекта отклоняется без изменения разделов", () => {
    withKnowledgeFixture((service, db) => {
      const project = service.get("project");
      const generation = db.getGeneration();

      expectRelayError(
        () => service.update("project", undefined, { documentSections: [] }, write(project)),
        "INVALID_ARGUMENT",
      );

      expect(service.get("project")).toEqual(project);
      expect(db.getGeneration()).toBe(generation);
    });
  });

  test("неизвестный фильтр фич даёт INVALID_ARGUMENT", () => {
    withKnowledgeFixture((service) => {
      expectRelayError(() => service.list("feature", { unknown: "value" }), "INVALID_ARGUMENT");
    });
  });

  test("строковый active в фильтре реализаций даёт INVALID_ARGUMENT", () => {
    withKnowledgeFixture((service) => {
      expectRelayError(
        () => service.list("implementation", { active: "false" }),
        "INVALID_ARGUMENT",
      );
    });
  });

  test("сценарий без фичи не создаёт первое участие приложения", () => {
    withKnowledgeFixture((service, db) => {
      const { scenario, application } = createKnowledgeRequirements(service);
      const snapshot = db.list();
      const generation = db.getGeneration();

      expectRelayError(
        () => service.replaceParticipation(application.id, [scenario.id], write(application)),
        "INVALID_ARGUMENT",
      );

      expect(db.list()).toEqual(snapshot);
      expect(db.getGeneration()).toBe(generation);
    });
  });
});
