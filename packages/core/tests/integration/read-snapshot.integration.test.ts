import { describe, expect, test } from "bun:test";
import { ProjectDatabase } from "@relay/storage";
import { HistoryService } from "../../src/history/history";
import { KnowledgeService } from "../../src/knowledge/knowledge";
import { PlanningService } from "../../src/planning/planning";
import { TasksService } from "../../src/tasks/tasks";
import { entityWriteOptions, withEntityDatabase } from "./helpers/entity-fixture";

describe("Предметное чтение при активном писателе", () => {
  test("удерживаемая запись оставляет прежний снимок доступным всем предметным чтениям", async () => {
    await withEntityDatabase(async (writer) => {
      const knowledge = new KnowledgeService(writer);
      const tasks = new TasksService(writer);
      const planning = new PlanningService(writer);
      const history = new HistoryService(writer);
      const document = await knowledge.create(
        "document",
        { name: "Правила", body: "До записи" },
        "human",
      );
      const task = await tasks.create({ title: "Работа" }, "human");
      const initialPlan = await planning.create(
        "work-plan",
        { title: "План", goal: "Проверить работу" },
        "human",
      );
      const stagedPlan = await planning.stage(
        initialPlan.id,
        "create",
        { title: "Этап" },
        entityWriteOptions(initialPlan, "human"),
      );
      const stage = stagedPlan.data.stages[0];
      if (!stage) {
        throw new Error("Подготовка плана не создала этап");
      }
      const plan = await planning.stageTask(
        stagedPlan.id,
        stage.id,
        task.id,
        false,
        entityWriteOptions(stagedPlan, "human"),
      );
      const session = await history.start({ title: "Проверка" }, "agent");
      const generation = writer.getGeneration();

      writer.transaction(() => {
        // Техническая запись удерживает реальный SQLite lock синхронно: предметные
        // async writers загружают контекст до commit и не вызываются внутри transaction.
        writer.update(
          {
            ...document,
            revision: document.revision + 1,
            data: { ...document.data, body: "После записи" },
          },
          document.revision,
        );
        writer.update(
          { ...task, revision: task.revision + 1, data: { ...task.data, column: "done" } },
          task.revision,
        );

        // Читатель открывается уже при write-lock. BEGIN IMMEDIATE в любом из чтений
        // дал бы STORAGE_BUSY; незавершённая запись должна остаться невидимой в WAL.
        const reader = ProjectDatabase.open(writer.path);
        try {
          const readKnowledge = new KnowledgeService(reader);
          const readTasks = new TasksService(reader);
          const readPlanning = new PlanningService(reader);
          const readHistory = new HistoryService(reader);

          const storedDocument = readKnowledge.get("document", document.id);
          const documents = readKnowledge.list("document");
          const storedTasks = readTasks.list();
          const taskProgress = readTasks.progress(task.id);
          const dependencies = readTasks.dependencies(task.id);
          const planProgress = readPlanning.progress("work-plan", plan.id);
          const sessions = readHistory.list();
          const tree = readHistory.tree(session.id);
          const context = readHistory.context(session.id);
          const intents = readHistory.intents(session.id);
          const checkpoints = readHistory.history(session.id);

          expect(storedDocument).toEqual(document);
          expect(documents).toEqual([document]);
          expect(storedTasks).toEqual([task]);
          expect(taskProgress.completed).toBe(false);
          expect(dependencies).toEqual([]);
          expect(planProgress.completed).toBe(false);
          expect(sessions).toEqual([session]);
          expect(tree).toHaveLength(1);
          expect(context.session).toEqual(session);
          expect(intents).toEqual([]);
          expect(checkpoints).toEqual([]);
          expect(reader.getGeneration()).toBe(generation);
        } finally {
          reader.close();
        }
      });

      // После commit новое соединение подтверждает, что конкурентная запись состоялась.
      const reader = ProjectDatabase.open(writer.path);
      try {
        expect(new KnowledgeService(reader).get("document", document.id).data.body).toBe(
          "После записи",
        );
        expect(new TasksService(reader).progress(task.id).completed).toBe(true);
        expect(reader.getGeneration()).toBeGreaterThan(generation);
      } finally {
        reader.close();
      }
    });
  });
});
