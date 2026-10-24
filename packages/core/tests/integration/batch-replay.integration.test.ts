import { Database } from "bun:sqlite";
import { describe, expect, test, spyOn } from "bun:test";
import { ProjectDatabase } from "@relay/storage";
import { BatchService } from "../../src/batch/batch";
import { KnowledgeService } from "../../src/knowledge/knowledge";
import { expectAsyncRelayError, withEntityDatabase } from "./helpers/entity-fixture";

describe("Первоначальная квитанция и повторная доставка", () => {
  test("загрузка свободна от writer-lock, commit удерживает его, а повтор возвращает исходный результат", async () => {
    await withEntityDatabase(async (db) => {
      const input = {
        version: 1,
        operations: [{ op: "document.create", input: { name: "Публикация", body: "Текст" } }],
      };
      const options = { actor: "agent", operationKey: "competing-delivery" };
      // У второго SQLite-писателя нет ожидания: проверяем удержание lock, а не штатный busy timeout.
      const competitor = new Database(db.path, { create: false, readwrite: true });
      const load = db.commands.load.bind(db.commands);
      const commit = db.commands.commit.bind(db.commands);
      const transaction = db.transaction.bind(db);
      let loadedOutsideLock = false;
      let committing = false;
      let attempted = false;
      let rejected: unknown;
      const reads = spyOn(db.commands, "load").mockImplementation(async (request) => {
        const result = await load(request);
        competitor.exec("BEGIN IMMEDIATE; ROLLBACK;");
        loadedOutsideLock = true;
        return result;
      });
      const commits = spyOn(db.commands, "commit").mockImplementation(async (plan) => {
        committing = true;
        try {
          return await commit(plan);
        } finally {
          committing = false;
        }
      });
      const writerLock = spyOn(db, "transaction").mockImplementation((operation) =>
        transaction(() => {
          if (committing && !attempted) {
            // Callback выполняется под настоящим BEGIN IMMEDIATE, до проверки receipt/guards.
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
          }
          return operation();
        }),
      );
      try {
        const committed = await new BatchService(db).execute(input, options);
        const generation = db.getGeneration();

        expect(loadedOutsideLock).toBe(true);
        expect(attempted).toBe(true);
        expect(rejected).toMatchObject({ code: "SQLITE_BUSY" });
        competitor.exec("BEGIN IMMEDIATE; ROLLBACK;");
        const replayed = await new BatchService(db).execute(input, options);
        expect(replayed).toEqual({ ...committed, replayed: true });
        expect(db.list("document")).toEqual([...committed.entities]);
        expect(db.getGeneration()).toBe(generation);
      } finally {
        reads.mockRestore();
        commits.mockRestore();
        writerLock.mockRestore();
        competitor.close();
      }
    });
  });

  test("доставка между load и commit возвращает выигравшую квитанцию без второго создания", async () => {
    await withEntityDatabase(async (db) => {
      const input = {
        version: 1,
        operations: [{ op: "document.create", input: { name: "Публикация", body: "Текст" } }],
      };
      const options = { actor: "agent", operationKey: "racing-delivery" };
      const competitor = ProjectDatabase.open(db.path);
      const commit = db.commands.commit.bind(db.commands);
      const winner = new BatchService(competitor);
      let winningGeneration: number | undefined;
      const delivery = spyOn(db.commands, "commit").mockImplementationOnce(async (plan) => {
        // Первый executor уже рассчитал effects и IDs, но ещё не вошёл в writer lock.
        await winner.execute(input, options);
        winningGeneration = competitor.getGeneration();
        return commit(plan);
      });
      try {
        const replayed = await new BatchService(db).execute(input, options);
        const receipt = winner.getResult(options.operationKey);

        if (winningGeneration === undefined) {
          throw new Error("Конкурентная доставка не завершила commit");
        }
        expect(delivery).toHaveBeenCalledTimes(1);
        expect(replayed.replayed).toBe(true);
        expect(replayed).toEqual(receipt);
        expect(db.list("document")).toEqual([...receipt.entities]);
        expect(db.getGeneration()).toBe(winningGeneration);
        const next = await new KnowledgeService(db).create(
          "document",
          { name: "Следующий", body: "Без двойного расходования ключа" },
          "agent",
        );
        expect(next.key).toBe("DOC-2");
      } finally {
        delivery.mockRestore();
        competitor.close();
      }
    });
  });

  test("reopen и последующие правки не меняют результат и не повторяют разрешение адресов/CAS", async () => {
    await withEntityDatabase(async (db) => {
      const knowledge = new KnowledgeService(db);
      const existing = await knowledge.create(
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
      const first = await new BatchService(db).execute(input, {
        actor: "agent",
        operationKey: "publication",
      });
      const created = first.entities.find((entity) => entity.id === first.items[0]?.id);
      if (created === undefined) {
        throw new Error("Созданная запись отсутствует в квитанции");
      }
      await knowledge.update(
        "document",
        created.id,
        { body: "Новый текущий текст" },
        { actor: "editor", ifRevision: created.revision },
      );
      await knowledge.update(
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
        const portReads = spyOn(reopened.commands, "load");
        const commits = spyOn(reopened.commands, "commit");
        const batch = new BatchService(reopened);
        try {
          const replayed = await batch.execute(input, {
            actor: "agent",
            operationKey: "publication",
          });
          const recovered = batch.getResult("publication");

          expect(replayed).toEqual({ ...first, replayed: true });
          expect(recovered).toEqual(replayed);
          expect(replayed.entities.find((entity) => entity.id === created.id)).toEqual(created);
          expect(addressReads).not.toHaveBeenCalled();
          expect(entityReads).not.toHaveBeenCalled();
          expect(selectionReads).not.toHaveBeenCalled();
          expect(projectReads).not.toHaveBeenCalled();
          expect(portReads.mock.calls.flatMap(([request]) => request.selectors)).toEqual([
            { kind: "receipt", operationKey: "publication" },
          ]);
          expect(commits).not.toHaveBeenCalled();
          expect(reopened.getGeneration()).toBe(generation);
          expect(reopened.count()).toBe(count);
        } finally {
          addressReads.mockRestore();
          entityReads.mockRestore();
          selectionReads.mockRestore();
          projectReads.mockRestore();
          portReads.mockRestore();
          commits.mockRestore();
        }
      } finally {
        reopened.close();
      }
    });
  });

  test("порядок свойств незначим, но автор, поля defaults, адреса и локальные имена значимы", async () => {
    await withEntityDatabase(async (db) => {
      const batch = new BatchService(db);
      const input = {
        version: 1,
        operations: [{ op: "task.create", as: "task", input: { title: "Задача" } }],
      };
      const first = await batch.execute(input, { actor: "agent", operationKey: "identity" });

      const reordered = await batch.execute(
        { operations: [{ input: { title: "Задача" }, as: "task", op: "task.create" }], version: 1 },
        { actor: "agent", operationKey: "identity" },
      );

      expect(reordered).toEqual({ ...first, replayed: true });
      await expectAsyncRelayError(
        () =>
          batch.execute(
            { version: 1, operations: [{ op: "unknown.operation" }] },
            { actor: "agent", operationKey: "identity" },
          ),
        "CONFLICT",
      );
      await expectAsyncRelayError(
        () => batch.execute(input, { actor: "other", operationKey: "identity" }),
        "CONFLICT",
      );
      await expectAsyncRelayError(
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
      await expectAsyncRelayError(
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

  test("отсутствующий input отличается от явного пустого input", async () => {
    await withEntityDatabase(async (db) => {
      const batch = new BatchService(db);
      await batch.execute(
        { version: 1, operations: [{ op: "task.create" }] },
        { actor: "agent", operationKey: "empty" },
      );

      await expectAsyncRelayError(
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

  test("структурированные scope и relations сохраняют ID, квитанция сохраняет старый раздел", async () => {
    await withEntityDatabase(async (db) => {
      const batch = new BatchService(db);
      const first = await batch.execute(
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
      await knowledge.changeSection(
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
