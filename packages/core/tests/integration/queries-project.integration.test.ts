import { describe, expect, spyOn, test } from "bun:test";
import type { EntityKind, EntityRecord, KnowledgeRecord } from "@relay/contracts";
import { ProjectDatabase } from "@relay/storage";
import { KnowledgeService } from "../../src/knowledge/knowledge";
import { QueryService } from "../../src/queries/queries";
import { entityWriteOptions, expectRelayError, withEntityDatabase } from "./helpers/entity-fixture";

const actor = "tester";
const sectionStates = [
  { name: "активного", retired: false },
  { name: "снятого", retired: true },
] as const;

/**
 * Выполняет запрос или проверку его отказа и подтверждает одно полное чтение без адресных чтений.
 * Настоящие методы Storage продолжают работать; перехваты снимаются даже при падении утверждений.
 */
function expectFullSnapshotRead<T>(db: ProjectDatabase, operation: () => T): T {
  const lists = spyOn(db, "list");
  const records = spyOn(db, "get");
  const identities = spyOn(db, "getIdentity");
  try {
    const result = operation();
    expect(lists).toHaveBeenCalledTimes(1);
    expect(records).not.toHaveBeenCalled();
    expect(identities).not.toHaveBeenCalled();
    return result;
  } finally {
    lists.mockRestore();
    records.mockRestore();
    identities.mockRestore();
  }
}

describe("Проект из полного снимка общих запросов", () => {
  test("обзор seed-проекта возвращает исходную карточку без её повторного чтения", () => {
    withEntityDatabase((db) => {
      const project = new KnowledgeService(db).get("project");
      const generation = db.getGeneration();
      const queries = new QueryService(db);

      const overview = expectFullSnapshotRead(db, () => queries.overview());

      expect(overview.project).toEqual(project);
      expect(overview.items.find((item) => item.id === project.id)).toEqual(project);
      expect(overview.items).toHaveLength(3);
      expect(overview.generation).toBe(generation);
      expect(overview.counts).toEqual({
        project: 1,
        product: 1,
        feature: 0,
        scenario: 0,
        application: 0,
        implementation: 0,
        board: 1,
        document: 0,
        task: 0,
        "work-plan": 0,
        release: 0,
        "work-session": 0,
        "work-checkpoint": 0,
      });
      expect(overview.tasks).toEqual({
        total: 0,
        blocked: 0,
        columns: { inbox: 0, ready: 0, "in-progress": 0, review: 0, done: 0, cancelled: 0 },
      });
    });
  });

  test.each(sectionStates)(
    "обзор сохраняет содержание и ссылки $name раздела без повторного чтения проекта",
    ({ retired }) => {
      withEntityDatabase((db) => {
        const knowledge = new KnowledgeService(db);
        let project = knowledge.changeSection(
          "create",
          { id: "guides", name: "Руководства" },
          entityWriteOptions(knowledge.get("project")),
        );
        const first = knowledge.create(
          "document",
          {
            name: "Первый Ω",
            body: "# Правила Ω\n\n  Текст\tс пробелами  \n",
            sectionId: "guides",
          },
          actor,
        );
        const second = knowledge.create(
          "document",
          { name: "Второй", body: "Другое руководство", sectionId: "guides" },
          actor,
        );
        if (retired) {
          project = knowledge.changeSection(
            "remove",
            { id: "guides" },
            entityWriteOptions(project),
          );
        }
        const snapshot = db.list();
        const generation = db.getGeneration();
        const queries = new QueryService(db);

        const overview = expectFullSnapshotRead(db, () => queries.overview());

        expect(overview.project).toEqual(project);
        expect(overview.items.filter((item) => item.kind === "document")).toEqual([first, second]);
        expect(overview.items.map((item) => item.key)).toEqual([
          "BOARD-PRODUCT",
          "DOC-1",
          "DOC-2",
          "PRODUCT",
          "PROJECT",
        ]);
        expect(overview.generation).toBe(generation);
        expect(overview.counts.document).toBe(2);
        expect(db.list()).toEqual(snapshot);
        expect(db.getGeneration()).toBe(generation);
      });
    },
  );

  test("обзор отклоняет неизвестный раздел по уже прочитанному проекту", () => {
    withEntityDatabase((db) => {
      const document = new KnowledgeService(db).create(
        "document",
        { name: "Документ", body: "Содержание" },
        actor,
      );
      // Этот раздел никогда не существовал и не входит в резерв снятых ID.
      const corruptedRecord = {
        ...document,
        revision: document.revision + 1,
        data: { ...document.data, sectionId: "never-existed" },
      };
      db.update(corruptedRecord, document.revision);
      const generation = db.getGeneration();
      const queries = new QueryService(db);

      const error = expectFullSnapshotRead(db, () =>
        expectRelayError(() => queries.overview(), "CORRUPT_DATA"),
      );

      expect(error.details).toEqual({ id: document.id, field: "sectionId" });
      expect(db.get(document.id)).toEqual(corruptedRecord);
      expect(db.getGeneration()).toBe(generation);
    });
  });

  test("повреждённый каталог проекта остаётся CORRUPT_DATA обзора", () => {
    withEntityDatabase((db) => {
      const knowledge = new KnowledgeService(db);
      const project = knowledge.get("project");
      knowledge.create("document", { name: "Документ", body: "Содержание" }, actor);
      // null нельзя трактовать как пустой каталог даже у документа без раздела.
      const corruptedProject = {
        ...project,
        revision: project.revision + 1,
        data: { ...project.data, documentSections: null },
      };
      db.update(corruptedProject, project.revision);
      const generation = db.getGeneration();
      const queries = new QueryService(db);

      const error = expectFullSnapshotRead(db, () =>
        expectRelayError(() => queries.overview(), "CORRUPT_DATA"),
      );

      expect(error.details).toEqual({ id: project.id, kind: "project", field: "documentSections" });
      expect(db.get(project.id)).toEqual(corruptedProject);
      expect(db.getGeneration()).toBe(generation);
    });
  });

  test("doctor собирает повреждения каталога для проекта и всех документов без перечитывания", () => {
    withEntityDatabase((db) => {
      const knowledge = new KnowledgeService(db);
      const project = knowledge.get("project");
      const first = knowledge.create("document", { name: "Первый", body: "Содержание" }, actor);
      const second = knowledge.create("document", { name: "Второй", body: "Содержание" }, actor);
      // Повреждение проекта не должно прервать сбор диагностик до обхода карточек.
      db.update(
        {
          ...project,
          revision: project.revision + 1,
          data: { ...project.data, documentSections: null },
        },
        project.revision,
      );
      const snapshot = db.list();
      const generation = db.getGeneration();
      const queries = new QueryService(db);

      const error = expectFullSnapshotRead(db, () =>
        expectRelayError(() => queries.check(), "INTEGRITY_ERROR"),
      );

      expect(error.details).toEqual({
        valid: false,
        records: 5,
        issues: [
          expect.stringMatching(new RegExp(`^${first.key}: .*documentSections`)),
          expect.stringMatching(new RegExp(`^${second.key}: .*documentSections`)),
          expect.stringMatching(new RegExp(`^${project.key}: .*documentSections`)),
        ],
      });
      expect(db.list()).toEqual(snapshot);
      expect(db.getGeneration()).toBe(generation);
    });
  });

  test("doctor заново строит каталог после добавления раздела между операциями", () => {
    withEntityDatabase((db) => {
      const knowledge = new KnowledgeService(db);
      knowledge.create("document", { name: "Первый", body: "Содержание" }, actor);
      const queries = new QueryService(db);
      const before = queries.check();
      knowledge.changeSection(
        "create",
        { id: "guides", name: "Руководства" },
        entityWriteOptions(knowledge.get("project")),
      );
      knowledge.create(
        "document",
        { name: "Новый", body: "Руководство", sectionId: "guides" },
        actor,
      );
      const generation = db.getGeneration();

      const after = expectFullSnapshotRead(db, () => queries.check());

      expect(after).toEqual({
        projectId: db.projectId,
        generation,
        valid: true,
        records: 5,
        issues: [],
      });
      expect(after.generation).toBeGreaterThan(before.generation);
    });
  });

  test("обзор удерживает каталог и поколение снимка, следующий вызов видит новый раздел", () => {
    withEntityDatabase((db) => {
      const knowledge = new KnowledgeService(db);
      const project = knowledge.get("project");
      const first = knowledge.create("document", { name: "Первый", body: "Содержание" }, actor);
      const generation = db.getGeneration();
      const queries = new QueryService(db);
      const writer = ProjectDatabase.open(db.path);
      let updatedProject: KnowledgeRecord<"project"> | undefined;
      let addedDocument: KnowledgeRecord<"document"> | undefined;
      /**
       * Сохраняет настоящее чтение, чтобы commit писателя происходил после фиксации снимка.
       */
      const originalList: (kind?: EntityKind) => EntityRecord[] = db.list.bind(db);
      const list = spyOn(db, "list").mockImplementationOnce((kind) => {
        const records = originalList(kind);
        const writing = new KnowledgeService(writer);
        updatedProject = writing.changeSection(
          "create",
          { id: "guides", name: "Руководства" },
          entityWriteOptions(project),
        );
        addedDocument = writing.create(
          "document",
          { name: "Новый", body: "Руководство", sectionId: "guides" },
          actor,
        );
        return records;
      });
      try {
        const overview = queries.overview();

        expect(overview.project).toEqual(project);
        expect(overview.items.filter((item) => item.kind === "document")).toEqual([first]);
        expect(overview.generation).toBe(generation);
      } finally {
        list.mockRestore();
        writer.close();
      }
      if (updatedProject === undefined || addedDocument === undefined) {
        throw new Error("Писатель не создал раздел и документ между чтениями обзора");
      }

      const next = expectFullSnapshotRead(db, () => queries.overview());

      expect(next.project).toEqual(updatedProject);
      expect(next.items.filter((item) => item.kind === "document")).toEqual([first, addedDocument]);
      expect(next.generation).toBe(db.getGeneration());
      expect(next.generation).toBeGreaterThan(generation);
    });
  });
});
