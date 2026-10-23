import { Database } from "bun:sqlite";
import { describe, expect, test, spyOn } from "bun:test";
import { ProjectDatabase } from "@relay/storage";
import { BatchService } from "../../src/batch/batch";
import { KnowledgeService } from "../../src/knowledge/knowledge";
import { expectRelayError, withEntityDatabase } from "./helpers/entity-fixture";

describe("Первоначальная квитанция и повторная доставка", () => {
  test("проверка ключа удерживает writer-lock, а повтор после commit возвращает исходный результат", () => {
    withEntityDatabase((db) => {
      const input = {
        version: 1,
        operations: [{ op: "document.create", input: { name: "Публикация", body: "Текст" } }],
      };
      const options = { actor: "agent", operationKey: "competing-delivery" };
      // У второго SQLite-писателя нет ожидания: проверяем удержание lock, а не штатный busy timeout.
      const competitor = new Database(db.path, { create: false, readwrite: true });
      /**
       * Сохраняет настоящее чтение квитанции; spy служит только точным барьером второго писателя.
       */
      const readReceipt: ProjectDatabase["getBatchReceipt"] = db.getBatchReceipt.bind(db);
      let attempted = false;
      let rejected: unknown;
      const receiptRead = spyOn(db, "getBatchReceipt").mockImplementationOnce((key) => {
        const receipt = readReceipt(key);
        attempted = true;
        try {
          competitor.exec("BEGIN IMMEDIATE");
        } catch (error) {
          rejected = error;
        } finally {
          if (competitor.inTransaction) {
            competitor.exec("ROLLBACK");
          }
        }
        return receipt;
      });
      try {
        const committed = new BatchService(db).execute(input, options);
        const generation = db.getGeneration();

        expect(attempted).toBe(true);
        expect(rejected).toMatchObject({ code: "SQLITE_BUSY" });
        competitor.exec("BEGIN IMMEDIATE; ROLLBACK;");
        const replayed = new BatchService(db).execute(input, options);
        expect(replayed).toEqual({ ...committed, replayed: true });
        expect(db.list("document")).toEqual([...committed.entities]);
        expect(db.getGeneration()).toBe(generation);
      } finally {
        receiptRead.mockRestore();
        competitor.close();
      }
    });
  });

  test("reopen и последующие правки не меняют результат и не повторяют разрешение адресов/CAS", () => {
    withEntityDatabase((db) => {
      const knowledge = new KnowledgeService(db);
      const existing = knowledge.create(
        "document",
        { name: "Первая редакция", body: "Первый текст" },
        "author",
      );
      const input = {
        version: 1,
        operations: [
          {
            op: "document.create",
            as: "created",
            input: { name: "Публикация", body: "# Исходный Markdown\n\nСодержание." },
          },
          {
            op: "document.update",
            ref: existing.key,
            ifRevision: existing.revision,
            input: { documentStatus: "archived" },
          },
        ],
      };
      const first = new BatchService(db).execute(input, {
        actor: "agent",
        operationKey: "publication",
      });
      const created = first.entities.find((entity) => entity.id === first.items[0]?.id);
      if (created === undefined) {
        throw new Error("Созданная запись отсутствует в квитанции");
      }
      knowledge.update(
        "document",
        created.id,
        { body: "Новый текущий текст" },
        { actor: "editor", ifRevision: created.revision },
      );
      knowledge.update(
        "document",
        existing.id,
        { body: "Правка после архивирования" },
        { actor: "editor", ifRevision: existing.revision + 1 },
      );
      const generation = db.getGeneration();
      const count = db.count();
      db.close();
      const reopened = ProjectDatabase.open(db.path);
      try {
        const addressReads = spyOn(reopened, "getIdentity");
        const entityReads = spyOn(reopened, "get");
        const selectionReads = spyOn(reopened, "getMany");
        const projectReads = spyOn(reopened, "list");
        const batch = new BatchService(reopened);
        try {
          const replayed = batch.execute(input, { actor: "agent", operationKey: "publication" });
          const recovered = batch.getResult("publication");

          expect(replayed).toEqual({ ...first, replayed: true });
          expect(recovered).toEqual(replayed);
          expect(replayed.entities.find((entity) => entity.id === created.id)).toEqual(created);
          expect(addressReads).not.toHaveBeenCalled();
          expect(entityReads).not.toHaveBeenCalled();
          expect(selectionReads).not.toHaveBeenCalled();
          expect(projectReads).not.toHaveBeenCalled();
          expect(reopened.getGeneration()).toBe(generation);
          expect(reopened.count()).toBe(count);
        } finally {
          addressReads.mockRestore();
          entityReads.mockRestore();
          selectionReads.mockRestore();
          projectReads.mockRestore();
        }
      } finally {
        reopened.close();
      }
    });
  });

  test("порядок свойств незначим, но автор, поля defaults, адреса и локальные имена значимы", () => {
    withEntityDatabase((db) => {
      const batch = new BatchService(db);
      const input = {
        version: 1,
        operations: [{ op: "task.create", as: "task", input: { title: "Задача" } }],
      };
      const first = batch.execute(input, { actor: "agent", operationKey: "identity" });

      const reordered = batch.execute(
        { operations: [{ input: { title: "Задача" }, as: "task", op: "task.create" }], version: 1 },
        { actor: "agent", operationKey: "identity" },
      );

      expect(reordered).toEqual({ ...first, replayed: true });
      expectRelayError(
        () =>
          batch.execute(
            { version: 1, operations: [{ op: "unknown.operation" }] },
            { actor: "agent", operationKey: "identity" },
          ),
        "CONFLICT",
      );
      expectRelayError(
        () => batch.execute(input, { actor: "other", operationKey: "identity" }),
        "CONFLICT",
      );
      expectRelayError(
        () =>
          batch.execute(
            {
              version: 1,
              operations: [
                { op: "task.create", as: "task", input: { title: "Задача", column: "inbox" } },
              ],
            },
            { actor: "agent", operationKey: "identity" },
          ),
        "CONFLICT",
      );
      expectRelayError(
        () =>
          batch.execute(
            {
              version: 1,
              operations: [{ op: "task.create", as: "renamed", input: { title: "Задача" } }],
            },
            { actor: "agent", operationKey: "identity" },
          ),
        "CONFLICT",
      );
      expect(db.count("task")).toBe(1);
    });
  });

  test("отсутствующий input отличается от явного пустого input", () => {
    withEntityDatabase((db) => {
      const batch = new BatchService(db);
      batch.execute(
        { version: 1, operations: [{ op: "task.create" }] },
        { actor: "agent", operationKey: "empty" },
      );

      expectRelayError(
        () =>
          batch.execute(
            { version: 1, operations: [{ op: "task.create", input: {} }] },
            { actor: "agent", operationKey: "empty" },
          ),
        "CONFLICT",
      );

      expect(db.count("task")).toBe(1);
    });
  });

  test("структурированные scope и relations сохраняют ID, квитанция сохраняет старый раздел", () => {
    withEntityDatabase((db) => {
      const batch = new BatchService(db);
      const first = batch.execute(
        {
          version: 1,
          operations: [
            { op: "feature.create", as: "feature", input: { name: "Описание" } },
            {
              op: "plan.create",
              input: { title: "План", scope: [{ kind: "feature", id: { $ref: "feature" } }] },
            },
            {
              op: "document.section.create",
              as: "section",
              ifRevision: 1,
              input: { id: "specs", name: "Спецификации" },
            },
            {
              op: "document.create",
              input: {
                name: "Описание",
                body: "Тело",
                sectionId: { $ref: "section" },
                relations: [{ target: { kind: "feature", id: { $ref: "feature" } } }],
              },
            },
          ],
        },
        { actor: "agent", operationKey: "section" },
      );
      const document = first.entities.find((entity) => entity.kind === "document");
      const knowledge = new KnowledgeService(db);
      const project = knowledge.get("project");
      knowledge.changeSection(
        "remove",
        { id: "specs" },
        { actor: "editor", ifRevision: project.revision },
      );

      const recovered = batch.getResult("section");

      expect(recovered).toEqual({ ...first, replayed: true });
      expect(recovered.entities.find((entity) => entity.kind === "document")?.data.sectionId).toBe(
        "specs",
      );
      expect(knowledge.get("document", document?.id ?? "missing").data.sectionId).toBeNull();
      expect(first.entities.find((entity) => entity.kind === "work-plan")?.data.scope).toEqual([
        { kind: "feature", id: first.items[0]?.id ?? "missing" },
      ]);
    });
  });
});
