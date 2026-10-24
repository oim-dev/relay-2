import { describe, expect, spyOn, test } from "bun:test";
import assert from "node:assert/strict";
import { TasksService } from "../../src/tasks/tasks";
import { entityWriteOptions, expectAsyncRelayError } from "./helpers/entity-fixture";
import { withTaskConnections } from "./helpers/task-fixture";

describe("Guarded commit задач между двумя SQLite-соединениями", () => {
  test("переоткрытие обязательства после расчёта отклоняет done по graph predicate без повторного CAS", async () => {
    await withTaskConnections(async (db, peer) => {
      const tasks = new TasksService(db);
      const competing = new TasksService(peer);
      const dependency = await tasks.create({ title: "Обязательство", column: "done" }, "author");
      const current = await tasks.create(
        { column: "review", dependencies: [dependency.id] },
        "author",
      );
      const generation = db.getGeneration();
      const commit = db.commands.commit.bind(db.commands);
      const load = spyOn(db.commands, "load");
      let committedCompetitor = false;
      const barrier = spyOn(db.commands, "commit").mockImplementation(async (plan) => {
        // Все чтения и чистый расчёт завершены, writer lock ещё не взят.
        // Второе соединение коммитит именно внутри окна load → commit.
        await competing.move(dependency.id, { column: "ready" }, entityWriteOptions(dependency));
        committedCompetitor = true;
        return commit(plan);
      });
      try {
        const failure = await expectAsyncRelayError(
          () => tasks.move(current.id, { column: "done" }, entityWriteOptions(current)),
          "COMMAND_CONTEXT_CHANGED",
        );

        expect(failure.details).toMatchObject({ selector: { kind: "task-graph" } });
        expect(committedCompetitor).toBe(true);
        expect(barrier).toHaveBeenCalledTimes(1);
        expect(
          load.mock.calls
            .flatMap(([request]) => request.selectors)
            .filter((selector) => selector.kind === "task-graph"),
        ).toHaveLength(1);
        expect(tasks.get(current.id)).toEqual(current);
        expect(tasks.get(dependency.id)).toMatchObject({
          revision: dependency.revision + 1,
          data: { column: "ready" },
        });
        expect(tasks.progress(current.id)).toEqual({
          completed: false,
          canComplete: false,
          blockers: [dependency.id],
        });
        expect(db.getGeneration()).toBe(generation + 1);
      } finally {
        barrier.mockRestore();
        load.mockRestore();
      }
    });
  });

  test("новый невыполненный ребёнок защищает ранее пустой состав от конкурентного done", async () => {
    await withTaskConnections(async (db, peer) => {
      const tasks = new TasksService(db);
      const competing = new TasksService(peer);
      const parent = await tasks.create({ title: "Родитель", column: "review" }, "author");
      const generation = db.getGeneration();
      const commit = db.commands.commit.bind(db.commands);
      let childId: string | undefined;
      const barrier = spyOn(db.commands, "commit").mockImplementation(async (plan) => {
        childId = (await competing.create({ title: "Новая работа", parent: parent.id }, "peer")).id;
        return commit(plan);
      });
      try {
        const failure = await expectAsyncRelayError(
          () => tasks.move(parent.id, { column: "done" }, entityWriteOptions(parent)),
          "COMMAND_CONTEXT_CHANGED",
        );

        expect(failure.details).toMatchObject({ selector: { kind: "task-graph" } });
        expect(childId).toBeString();
        assert(childId !== undefined);
        expect(barrier).toHaveBeenCalledTimes(1);
        expect(tasks.get(parent.id)).toEqual(parent);
        expect(tasks.children(parent.id).map((child) => child.id)).toEqual([childId]);
        expect(tasks.progress(parent.id)).toEqual({
          completed: false,
          canComplete: false,
          blockers: [childId],
        });
        expect(db.getGeneration()).toBe(generation + 1);
      } finally {
        barrier.mockRestore();
      }
    });
  });

  test("поздний append не конфликтует с подготовленной правкой текста и входит в её результат", async () => {
    await withTaskConnections(async (db, peer) => {
      const tasks = new TasksService(db);
      const competing = new TasksService(peer);
      const current = await tasks.create({ title: "До правки" }, "author");
      const commit = db.commands.commit.bind(db.commands);
      const barrier = spyOn(db.commands, "commit").mockImplementation(async (plan) => {
        await competing.comment(current.id, "Независимое обсуждение", "peer");
        return commit(plan);
      });
      try {
        const changed = await tasks.update(
          current.id,
          { title: "После правки" },
          entityWriteOptions(current),
        );

        expect(changed).toMatchObject({
          revision: current.revision + 1,
          data: { title: "После правки" },
        });
        expect(changed.data.comments).toEqual([
          expect.objectContaining({ body: "Независимое обсуждение", createdBy: "peer" }),
        ]);
        expect(tasks.get(current.id)).toEqual(changed);
        expect(barrier).toHaveBeenCalledTimes(1);
      } finally {
        barrier.mockRestore();
      }
    });
  });

  test("независимые append сохраняются оба без изменения содержания и с заранее выделенным ID", async () => {
    await withTaskConnections(async (db, peer) => {
      const tasks = new TasksService(db);
      const competing = new TasksService(peer);
      const current = await tasks.create({}, "author");
      const commit = db.commands.commit.bind(db.commands);
      let allocatedId: string | undefined;
      const barrier = spyOn(db.commands, "commit").mockImplementation(async (plan) => {
        const effects = plan.transitions.flatMap((transition) => transition.effects);
        expect(effects).toHaveLength(1);
        const effect = effects[0];
        expect(effect?.kind).toBe("comment");
        if (effect?.kind === "comment") {
          allocatedId = effect.comment.id;
        }
        await competing.comment(current.id, "Параллельный комментарий", "peer");
        return commit(plan);
      });
      try {
        const result = await tasks.comment(current.id, "Подготовленный комментарий", "author");

        expect(result.revision).toBe(current.revision);
        expect(result.updatedAt).toBe(current.updatedAt);
        expect(result.updatedBy).toBe(current.updatedBy);
        expect(result.data.comments).toHaveLength(2);
        expect(result.data.comments.map((comment) => comment.body).sort()).toEqual([
          "Параллельный комментарий",
          "Подготовленный комментарий",
        ]);
        expect(result.data.comments.find((comment) => comment.id === allocatedId)?.body).toBe(
          "Подготовленный комментарий",
        );
        expect(tasks.get(current.id)).toEqual(result);
      } finally {
        barrier.mockRestore();
      }
    });
  });
});
