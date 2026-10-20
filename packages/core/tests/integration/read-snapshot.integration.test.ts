import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { ProjectDatabase } from "@relay/storage";
import { KnowledgeService } from "../../src/knowledge";
import { TasksService } from "../../src/tasks";
import { PlanningService } from "../../src/planning";
import { HistoryService } from "../../src/history";

test("предметные чтения видят согласованные данные, пока другое соединение удерживает запись", () => {
  const artifacts = resolve(
    import.meta.dir,
    "../../../../.artifacts",
    new Date().toISOString().slice(0, 10),
  );
  mkdirSync(artifacts, { recursive: true });
  const directory = mkdtempSync(join(artifacts, "core-read-snapshot-"));
  const writer = ProjectDatabase.create(join(directory, "project.sqlite"), {
    id: crypto.randomUUID(),
    name: "Параллельное чтение",
    slug: "snapshot",
  });
  try {
    const knowledge = new KnowledgeService(writer);
    const tasks = new TasksService(writer);
    const planning = new PlanningService(writer);
    const history = new HistoryService(writer);
    const document = knowledge.create("document", { name: "Правила", body: "До записи" }, "human");
    const task = tasks.create({ title: "Работа" }, "human");
    let plan = planning.create("work-plan", { title: "План", goal: "Проверить работу" }, "human");
    plan = planning.stage(
      plan.id,
      "create",
      { title: "Этап" },
      { actor: "human", ifRevision: plan.revision },
    );
    const stageId = (plan.data.stages as Array<{ id: string }>)[0]!.id;
    plan = planning.stageTask(plan.id, stageId, task.id, false, {
      actor: "human",
      ifRevision: plan.revision,
    });
    const session = history.start({ title: "Проверка" }, "agent");
    const generation = writer.getGeneration();

    writer.transaction(() => {
      knowledge.update(
        "document",
        document.id,
        { body: "После записи" },
        { actor: "human", ifRevision: document.revision },
      );
      tasks.move(task.id, { column: "done" }, { actor: "human", ifRevision: task.revision });

      // Читатель открывается уже при удерживаемом write-lock. BEGIN IMMEDIATE
      // в любом из этих чтений даст STORAGE_BUSY вместо прежнего снимка WAL.
      const reader = ProjectDatabase.open(writer.path);
      try {
        const readKnowledge = new KnowledgeService(reader);
        const readTasks = new TasksService(reader);
        const readPlanning = new PlanningService(reader);
        const readHistory = new HistoryService(reader);
        expect(readKnowledge.get("document", document.id).data.body).toBe("До записи");
        expect(readKnowledge.list("document")[0]!.data.body).toBe("До записи");
        expect(readTasks.list()[0]!.data.column).toBe("inbox");
        expect(readTasks.progress(task.id).completed).toBe(false);
        expect(readTasks.dependencies(task.id)).toEqual([]);
        expect(readPlanning.progress("work-plan", plan.id).completed).toBe(false);
        expect(readHistory.list()).toHaveLength(1);
        expect(readHistory.tree(session.id)).toHaveLength(1);
        expect(readHistory.context(session.id).session.id).toBe(session.id);
        expect(readHistory.intents(session.id)).toEqual([]);
        expect(readHistory.history(session.id)).toEqual([]);
        expect(reader.getGeneration()).toBe(generation);
      } finally {
        reader.close();
      }
    });

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
  } finally {
    writer.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
