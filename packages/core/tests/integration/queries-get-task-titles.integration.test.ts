import { describe, expect, test } from "bun:test";
import { QueryService } from "../../src/queries/queries";
import { TasksService } from "../../src/tasks/tasks";
import { withEntityDatabase } from "./helpers/entity-fixture";

const validTitles = [
  { name: "отсутствующий при создании", input: {}, expected: "" },
  { name: "явно пустой", input: { title: "" }, expected: "" },
  { name: "пробельный", input: { title: " \t  " }, expected: " \t  " },
] as const;
const corruptedTitles = [
  { name: "null", value: null },
  { name: "число", value: 17 },
  { name: "1025 символов", value: "З".repeat(1025) },
  { name: "NUL", value: "До\0после" },
  { name: "U+2028", value: "До\u2028после" },
] as const;

describe("Заголовок задачи в групповом чтении", () => {
  test.each(validTitles)(
    "$name заголовок задачи сохраняется дословно в full и summary",
    ({ input, expected }) => {
      withEntityDatabase((db) => {
        const task = new TasksService(db).create(input, "tester");
        const generation = db.getGeneration();
        const queries = new QueryService(db);

        const full = queries.getMany([task.key]);
        const summary = queries.getMany([task.key], { summary: true });

        expect(full).toEqual({
          view: "full",
          generation,
          items: [
            {
              ref: task.key,
              ok: true,
              entity: { ...task, data: { ...task.data, title: expected } },
            },
          ],
        });
        expect(summary).toEqual({
          view: "summary",
          generation,
          items: [
            {
              ref: task.key,
              ok: true,
              entity: {
                id: task.id,
                kind: "task",
                key: task.key,
                revision: task.revision,
                title: expected,
                state: "inbox",
              },
            },
          ],
        });
      });
    },
  );

  test.each(corruptedTitles)(
    "$name вместо сохранённого заголовка остаётся CORRUPT_DATA в обоих представлениях",
    ({ value }) => {
      withEntityDatabase((db) => {
        const task = new TasksService(db).create({}, "tester");
        // Storage намеренно обходит предметный ввод: null и число не означают безымянную задачу.
        const corrupted = {
          ...task,
          revision: task.revision + 1,
          data: { ...task.data, title: value },
        };
        db.update(corrupted, task.revision);
        const generation = db.getGeneration();
        const queries = new QueryService(db);

        const full = queries.getMany([task.id]);
        const summary = queries.getMany([task.id], { summary: true });

        const expected = [
          {
            ref: task.id,
            ok: false as const,
            error: expect.objectContaining({ code: "CORRUPT_DATA", exitCode: 1 }),
          },
        ];
        expect(full.items).toEqual(expected);
        expect(summary.items).toEqual(expected);
        expect(summary.items[0]).toMatchObject({
          error: { details: { id: task.id, kind: "task", field: "title" } },
        });
        expect(db.get(task.id)).toEqual(corrupted);
        expect(db.getGeneration()).toBe(generation);
      });
    },
  );
});
