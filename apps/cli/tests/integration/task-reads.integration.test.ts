import { describe, expect, spyOn, test } from "bun:test";
import assert from "node:assert/strict";
import { TasksService } from "@relay/core";
import { ProjectDatabase } from "@relay/storage";
import { withCliFixture } from "./helpers/cli-fixture";
import { objectValue, stringValue } from "./helpers/responses";
import type { TaskReadFixture } from "./helpers/task-read-fixture.types";

const nestedLists = [
  {
    group: "dependency",
    ownerField: "ref",
    seed: seedDependencies,
    fullReads: 3,
  },
  {
    group: "criterion",
    ownerField: "ref",
    seed: seedCriteria,
    fullReads: 1,
  },
  {
    group: "comment",
    ownerField: "task",
    seed: seedComments,
    fullReads: 1,
  },
] as const;

/**
 * Создаёт две зависимости в порядке, обратном созданию, и журнал одной из целей.
 * Соединением и очисткой владеет вызывающая fixture.
 */
function seedDependencies(db: ProjectDatabase): TaskReadFixture {
  const tasks = new TasksService(db);
  const first = tasks.create({ title: "Первая созданная" }, "fixture");
  const initial = tasks.create({ title: "Вторая созданная" }, "fixture");
  const second = tasks.comment(initial.id, "## Обсуждение\n\n  подробности\n", "рецензент");
  const task = tasks.create({ dependencies: [second.id, first.id] }, "fixture");
  return { task, items: [second, first] };
}

/**
 * Создаёт два критерия с полным текстом; отметка первого повышает ревизию владельца.
 * Соединением и очисткой владеет вызывающая fixture.
 */
function seedCriteria(db: ProjectDatabase): TaskReadFixture {
  const tasks = new TasksService(db);
  const initial = tasks.create(
    {
      title: "Приёмка",
      acceptanceCriteria: [
        { title: "Первый", summary: "Кратко", description: "## Проверка\n\n  отступ\n" },
        { title: "Второй" },
      ],
    },
    "fixture",
  );
  const [criterion] = initial.data.acceptanceCriteria;
  assert(criterion);
  const task = tasks.criterion(
    initial.id,
    "complete",
    { id: criterion.id },
    { actor: "рецензент", ifRevision: initial.revision },
  );
  return { task, items: task.data.acceptanceCriteria };
}

/**
 * Создаёт два независимых комментария с разными авторами и допустимым пустым заголовком.
 * Соединением и очисткой владеет вызывающая fixture.
 */
function seedComments(db: ProjectDatabase): TaskReadFixture {
  const tasks = new TasksService(db);
  const initial = tasks.create({ title: "Обсуждение" }, "fixture");
  tasks.comment(initial.id, "## Первый\n\n  точный отступ\n", "первый автор");
  const task = tasks.comment(initial.id, "Второй комментарий", "второй автор", "Ответ");
  return { task, items: task.data.comments };
}

describe("Вложенные чтения задач через CLI", () => {
  test.each(nestedLists)(
    "task $group list сохраняет JSON, порядок и курсор с одним чтением владельца",
    async ({ group, ownerField, seed, fullReads }) => {
      await withCliFixture(async (cli) => {
        const project = cli.createProject();
        const { task, items } = cli.withDatabase(project, seed);
        const [first, second] = items.map(objectValue);
        assert(first && second);
        const generation = cli.withDatabase(project, (db) => db.getGeneration());
        const command = ["task", group, "list", `task:${task.id}`];
        const fullRead = spyOn(ProjectDatabase.prototype, "get");
        const identityRead = spyOn(ProjectDatabase.prototype, "getIdentity");
        let cursor: string;
        try {
          const page = await cli.page([...command, "--limit", "1"], objectValue);

          expect(page.data).toEqual({
            [ownerField]: task.key,
            revision: task.revision,
            items: [first],
          });
          expect(page.meta.page).toMatchObject({ count: 1, total: 2, limit: 1 });
          expect(page.meta.page.nextCommand).toContain(`--config=${project.configPath}`);
          expect(page.meta.page.nextCommand).toContain("--format=json");
          cursor = stringValue(page.meta.page.nextCursor);
          expect(fullRead.mock.calls.filter(([, kind]) => kind === "task")).toHaveLength(fullReads);
          expect(fullRead.mock.calls.filter(([ref]) => ref === task.id)).toHaveLength(1);
          expect(identityRead.mock.calls.filter(([, kind]) => kind === "task")).toHaveLength(
            fullReads,
          );
          expect(identityRead.mock.calls.filter(([ref]) => ref === task.id)).toHaveLength(1);
        } finally {
          fullRead.mockRestore();
          identityRead.mockRestore();
        }

        const last = await cli.page([...command, "--cursor", cursor], objectValue);

        expect(last.data).toEqual({
          [ownerField]: task.key,
          revision: task.revision,
          items: [second],
        });
        expect(last.meta.page).toEqual({
          count: 1,
          total: 2,
          limit: 1,
          nextCursor: null,
          nextCommand: null,
          consistency: "snapshot",
        });
        cli.withDatabase(project, (db) => {
          expect(new TasksService(db).get(task.id)).toEqual(task);
          expect(db.getGeneration()).toBe(generation);
        });

        const appended = cli.withDatabase(project, (db) =>
          new TasksService(db).comment(task.id, "После страницы", "новый автор"),
        );
        const error = await cli.error([...command, "--cursor", cursor], 4);

        expect(error.code).toBe("SNAPSHOT_CONFLICT");
        expect(appended.revision).toBe(task.revision);
        expect(appended.data.comments.slice(0, -1)).toEqual(task.data.comments);
        cli.withDatabase(project, (db) => {
          expect(new TasksService(db).get(task.id)).toEqual(appended);
          expect(db.getGeneration()).toBe(generation + 1);
        });
      });
    },
  );

  test("criterion get сохраняет ключ, ревизию и полный критерий после одного чтения задачи", async () => {
    await withCliFixture(async (cli) => {
      const project = cli.createProject();
      const { task } = cli.withDatabase(project, seedCriteria);
      const [criterion] = task.data.acceptanceCriteria;
      assert(criterion);
      const generation = cli.withDatabase(project, (db) => db.getGeneration());
      const fullRead = spyOn(ProjectDatabase.prototype, "get");
      const identityRead = spyOn(ProjectDatabase.prototype, "getIdentity");
      try {
        const response = await cli.success([
          "task",
          "criterion",
          "get",
          `task:${task.id}`,
          criterion.id,
        ]);

        expect(response.data).toEqual({ task: task.key, revision: task.revision, criterion });
        expect(fullRead.mock.calls.filter(([ref]) => ref === task.id)).toHaveLength(1);
        expect(identityRead.mock.calls.filter(([ref]) => ref === task.id)).toHaveLength(1);
      } finally {
        fullRead.mockRestore();
        identityRead.mockRestore();
      }
      cli.withDatabase(project, (db) => {
        expect(new TasksService(db).get(task.id)).toEqual(task);
        expect(db.getGeneration()).toBe(generation);
      });
    });
  });

  test("criterion get отклоняет критерий чужой задачи с прежним NOT_FOUND и сохраняет данные", async () => {
    await withCliFixture(async (cli) => {
      const project = cli.createProject();
      const { task: other } = cli.withDatabase(project, seedCriteria);
      const owner = cli.withDatabase(project, (db) => new TasksService(db).create({}, "fixture"));
      const [criterion] = other.data.acceptanceCriteria;
      assert(criterion);
      const generation = cli.withDatabase(project, (db) => db.getGeneration());

      const error = await cli.error(["task", "criterion", "get", owner.key, criterion.id], 3);

      expect(error).toMatchObject({ code: "NOT_FOUND", details: { id: criterion.id } });
      cli.withDatabase(project, (db) => {
        const tasks = new TasksService(db);
        expect(tasks.get(owner.id)).toEqual(owner);
        expect(tasks.get(other.id)).toEqual(other);
        expect(db.getGeneration()).toBe(generation);
      });
    });
  });
});
