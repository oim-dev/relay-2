import { describe, expect, test } from "bun:test";
import { HistoryService } from "../../src/history/history";
import { KnowledgeService } from "../../src/knowledge/knowledge";
import { PlanningService } from "../../src/planning/planning";
import { QueryService } from "../../src/queries/queries";
import { TasksService } from "../../src/tasks/tasks";
import { entityWriteOptions as write, withEntityDatabase } from "./helpers/entity-fixture";

const historyTitles = [
  { name: "U+2028", title: "До\u2028после" },
  { name: "U+2029", title: "До\u2029после" },
] as const;
const planningKinds = ["work-plan", "release"] as const;
const corruptedPlanningTitles = [
  { name: "161 символ", title: "П".repeat(161) },
  { name: "NUL", title: "До\0после" },
] as const;
const corruptedProjectNames = [
  { name: "краевые пробелы", title: " Имя " },
  { name: "121 символ", title: "П".repeat(121) },
  { name: "управляющий символ", title: "До\0после" },
] as const;

describe("Предметные правила названий в full и summary", () => {
  test.each(historyTitles)(
    "история сохраняет допустимый $name из SQLite в обоих представлениях",
    ({ title }) => {
      withEntityDatabase((db) => {
        const history = new HistoryService(db);
        const initial = history.start({ title }, "tester");
        const checkpoint = history.checkpoint(
          initial.id,
          "open",
          {
            title,
            body: "Материал истории",
            runId: initial.data.currentRunId,
          },
          write(initial),
        );
        const session = history.get(initial.id);
        const refs = [session.key, checkpoint.key];
        const queries = new QueryService(db);

        const full = queries.getMany(refs);
        const summary = queries.getMany(refs, { summary: true });

        expect(full).toMatchObject({
          view: "full",
          items: [
            { ref: session.key, ok: true, entity: { id: session.id, data: { title } } },
            { ref: checkpoint.key, ok: true, entity: { id: checkpoint.id, data: { title } } },
          ],
        });
        expect(summary).toEqual({
          view: "summary",
          generation: full.generation,
          items: [
            {
              ref: session.key,
              ok: true,
              entity: {
                id: session.id,
                kind: "work-session",
                key: session.key,
                revision: session.revision,
                title,
                state: "open",
              },
            },
            {
              ref: checkpoint.key,
              ok: true,
              entity: {
                id: checkpoint.id,
                kind: "work-checkpoint",
                key: checkpoint.key,
                revision: checkpoint.revision,
                title,
              },
            },
          ],
        });
      });
    },
  );

  test("знание сохраняет краевые пробелы, NUL и название длиннее лимита планирования", () => {
    withEntityDatabase((db) => {
      const title = " До\0" + "Ф".repeat(161) + " ";
      const feature = new KnowledgeService(db).create("feature", { name: title }, "tester");
      const queries = new QueryService(db);

      const full = queries.getMany([feature.key]);
      const summary = queries.getMany([feature.key], { summary: true });

      expect(full.items).toEqual([{ ref: feature.key, ok: true, entity: feature }]);
      expect(summary.items).toEqual([
        {
          ref: feature.key,
          ok: true,
          entity: {
            id: feature.id,
            kind: "feature",
            key: feature.key,
            revision: feature.revision,
            title,
          },
        },
      ]);
    });
  });

  for (const kind of planningKinds) {
    test.each(corruptedPlanningTitles)(
      `${kind}: $name отклоняется обоими чтениями после допустимых 160 символов`,
      ({ title }) => {
        withEntityDatabase((db) => {
          const planning = new PlanningService(db);
          const validTitle = "П".repeat(160);
          const plan = planning.create("work-plan", { title: validTitle }, "tester");
          const record =
            kind === "work-plan"
              ? plan
              : planning.create(
                  "release",
                  {
                    title: validTitle,
                    version: "1",
                    planIds: [plan.id],
                  },
                  "tester",
                );
          const other = new TasksService(db).create({ title: "Соседняя" }, "tester");
          const queries = new QueryService(db);

          const validFull = queries.getMany([record.key]);
          const validSummary = queries.getMany([record.key], { summary: true });

          expect(validFull.items).toEqual([{ ref: record.key, ok: true, entity: record }]);
          expect(validSummary.items).toMatchObject([
            { ref: record.key, ok: true, entity: { title: validTitle } },
          ]);
          // Повреждается только выбранное поле, чтобы отказ полного чтения не маскировал иную причину.
          const corrupted = {
            ...record,
            revision: record.revision + 1,
            data: { ...record.data, title },
          };
          db.update(corrupted, record.revision);
          const generation = db.getGeneration();

          const full = queries.getMany([other.id, record.key]);
          const summary = queries.getMany([other.id, record.key], { summary: true });

          for (const result of [full, summary]) {
            expect(result.items).toHaveLength(2);
            expect(result.items[0]).toMatchObject({
              ref: other.id,
              ok: true,
              entity: { id: other.id },
            });
            expect(result.items[1]).toMatchObject({
              ref: record.key,
              ok: false,
              error: { code: "CORRUPT_DATA", exitCode: 1 },
            });
          }
          expect(db.get(record.id)).toEqual(corrupted);
          expect(db.getGeneration()).toBe(generation);
        });
      },
    );
  }

  test.each(corruptedProjectNames)(
    "имя проекта: $name не нормализуется и остаётся CORRUPT_DATA",
    ({ title }) => {
      withEntityDatabase((db) => {
        const project = new KnowledgeService(db).get("project");
        const task = new TasksService(db).create({}, "tester");
        const corrupted = {
          ...project,
          revision: project.revision + 1,
          data: { ...project.data, name: title },
        };
        db.update(corrupted, project.revision);
        const generation = db.getGeneration();
        const queries = new QueryService(db);

        const full = queries.getMany([project.id, task.id]);
        const summary = queries.getMany([project.id, task.id], { summary: true });

        for (const result of [full, summary]) {
          expect(result.items).toHaveLength(2);
          expect(result.items[0]).toMatchObject({
            ref: project.id,
            ok: false,
            error: { code: "CORRUPT_DATA", exitCode: 1 },
          });
          expect(result.items[1]).toMatchObject({
            ref: task.id,
            ok: true,
            entity: { id: task.id },
          });
        }
        expect(db.get(project.id)).toEqual(corrupted);
        expect(db.getGeneration()).toBe(generation);
      });
    },
  );
});
