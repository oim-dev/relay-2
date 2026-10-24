import { describe, expect, test } from "bun:test";
import { KnowledgeService } from "../../src/knowledge/knowledge";
import { TasksService } from "../../src/tasks/tasks";
import { withReplicationFixture } from "./helpers/replication-fixture";

describe("Причинность реально прочитанных локальных эффектов", () => {
  test("структурированная ссылка зависит от создания её неопубликованной цели", async () => {
    await withReplicationFixture(
      () => {},
      async ({ first }) => {
        const task = await new TasksService(first).create(
          { title: "Неопубликованная цель" },
          "author",
        );
        await new KnowledgeService(first).create(
          "document",
          { name: "Зависимый", body: "Связь по ID", targets: [task.id] },
          "author",
        );

        const changesets = first.getReplicationOutbox();

        expect(changesets).toHaveLength(2);
        const creation = changesets[0];
        const dependent = changesets[1];
        if (creation === undefined || dependent === undefined) {
          throw new Error("Нет changeset");
        }
        expect(dependent.dependencies).toContain(creation.id);
        expect(dependent.readContext).toContainEqual(
          expect.objectContaining({
            id: task.id,
            sourceChangesetId: creation.id,
            version: creation.entities[0]?.after?.version,
          }),
        );
      },
    );
  });

  test("обычное чтение и откатившийся read-savepoint не связывают последующую независимую запись", async () => {
    await withReplicationFixture(
      () => {},
      async ({ first }) => {
        const tasks = new TasksService(first);
        const knowledge = new KnowledgeService(first);
        const task = await tasks.create({ title: "Другая цепочка" }, "author");
        const creation = first.getReplicationOutbox()[0];
        if (creation === undefined) {
          throw new Error("Нет исходного changeset");
        }
        tasks.get(task.id);
        // Успешный no-op write-UOW обязан удалить временные основания, не создавая outbox.
        first.transaction(() => first.get(task.id));
        first.transaction(() => {
          try {
            first.transaction(() => {
              first.get(task.id);
              throw new Error("rollback read context");
            });
          } catch {
            /* Намеренно перехвачен отказ вложенного read-savepoint. */
          }
        });
        await knowledge.create(
          "document",
          { name: "Независимый", body: "Без ссылки на задачу" },
          "author",
        );

        const changesets = first.getReplicationOutbox();

        expect(changesets).toHaveLength(2);
        expect(changesets[1]?.dependencies).not.toContain(creation.id);
        expect(changesets[1]?.readContext.some((entry) => entry.id === task.id)).toBe(false);
      },
    );
  });

  test("комментарий существующей задачи не зависит от конфликтующей правки её содержания", async () => {
    await withReplicationFixture(
      async (db) => {
        await new TasksService(db).create({ title: "Общая" }, "seed");
      },
      async ({ first }) => {
        const tasks = new TasksService(first);
        const task = tasks.get("PRODUCT-1");
        await tasks.update(
          task.id,
          { title: "Локальная правка" },
          { actor: "editor", ifRevision: task.revision },
        );
        const content = first.getReplicationOutbox()[0];
        if (content === undefined) {
          throw new Error("Нет изменения содержания");
        }

        await tasks.comment(task.id, "Независимое обсуждение", "commenter");

        const comment = first.getReplicationOutbox()[1];
        expect(comment?.dependencies).not.toContain(content.id);
        expect(comment?.entities).toEqual([]);
        expect(comment?.comments).toHaveLength(1);
      },
    );
  });
});
