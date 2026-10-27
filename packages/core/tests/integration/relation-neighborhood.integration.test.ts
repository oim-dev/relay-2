import { describe, expect, test } from "bun:test";
import { KnowledgeService } from "../../src/knowledge/knowledge";
import { HistoryService } from "../../src/history/history";
import { PlanningService } from "../../src/planning/planning";
import { TasksService } from "../../src/tasks/tasks";
import type { HistoryCheckpoint } from "@relay/contracts";
import type { ProjectStore } from "@relay/storage";
import { readRelationNeighborhood } from "../../src/queries/relation-neighborhood";
import { withGraphViewFixture } from "./graph-view-fixture";

/**
 * Создаёт реальную ссылку истории через Core, оставляя все материалы в собственной fixture.
 */
async function createReferencedCheckpoint(
  db: ProjectStore,
  target: string,
): Promise<HistoryCheckpoint> {
  const history = new HistoryService(db);
  const session = await history.start({ title: "История ссылки" }, "Автор");
  const runId = session.data.currentRunId;
  if (runId === null) {
    throw new Error("Новая сессия должна иметь участие.");
  }
  return history.checkpoint(
    session.id,
    "open",
    { runId, title: "Материал", body: "Исходная ссылка", references: [target] },
    { actor: "Автор", ifRevision: session.revision },
  );
}

describe("Компактное соседство Core", () => {
  test("пробелы в допустимом заголовке этапа сохраняются в связи и не блокируют независимое чтение", async () => {
    await withGraphViewFixture(async (db) => {
      const planning = new PlanningService(db);
      const feature = await new KnowledgeService(db).create(
        "feature",
        { name: "Независимая цель" },
        "Автор",
      );
      const task = await new TasksService(db).create({ title: "Работа этапа" }, "Автор");
      const plan = await planning.create("work-plan", { title: "План" }, "Автор");
      const staged = await planning.stage(
        plan.id,
        "create",
        { title: " Этап " },
        {
          actor: "Автор",
          ifRevision: plan.revision,
        },
      );
      const stage = staged.data.stages[0];
      if (stage === undefined) {
        throw new Error("Созданный этап отсутствует в плане");
      }
      const assigned = await planning.stageTask(plan.id, stage.id, task.id, false, {
        actor: "Автор",
        ifRevision: staged.revision,
      });

      const page = readRelationNeighborhood(db, {
        ref: plan.id,
        type: "contains",
        direction: "outgoing",
        depth: 1,
      });
      const independent = readRelationNeighborhood(db, { ref: feature.id, depth: 0 });

      expect(page.edges).toHaveLength(1);
      expect(page.edges[0]).toMatchObject({
        from: { kind: "work-plan", id: plan.id },
        to: { kind: "task", id: task.id },
        description: " Этап ",
        revision: assigned.revision,
      });
      expect(independent.nodes.map((node) => node.ref.id)).toEqual([feature.id]);
      expect(independent.edges).toEqual([]);
    });
  });

  test.each([
    { name: "пустой", title: "" },
    { name: "многострочный", title: "Этап\nработы" },
  ])("$name сохранённый заголовок этапа отклоняется как повреждение", async ({ title }) => {
    await withGraphViewFixture(async (db) => {
      const planning = new PlanningService(db);
      const plan = await planning.create("work-plan", { title: "План" }, "Автор");
      const staged = await planning.stage(
        plan.id,
        "create",
        { title: "Этап" },
        {
          actor: "Автор",
          ifRevision: plan.revision,
        },
      );
      // Низкоуровневая запись воспроизводит повреждение, запрещённое публичным writer.
      db.update(
        {
          ...staged,
          revision: staged.revision + 1,
          data: {
            ...staged.data,
            stages: staged.data.stages.map((stage) => ({ ...stage, title })),
          },
        },
        staged.revision,
      );
      const generation = db.getGeneration();

      expect(() => readRelationNeighborhood(db, { ref: plan.id })).toThrow(
        expect.objectContaining({
          code: "CORRUPT_DATA",
          details: { id: plan.id, field: "stages.title" },
          cause: expect.objectContaining({ code: "VALIDATION_ERROR" }),
        }),
      );
      expect(db.getGeneration()).toBe(generation);
    });
  });

  test("references сохраняет постоянный ID, а узел показывает актуальную подпись цели", async () => {
    await withGraphViewFixture(async (db) => {
      const knowledge = new KnowledgeService(db);
      const feature = await knowledge.create("feature", { name: "Исходная цель" }, "Автор");
      const checkpoint = await createReferencedCheckpoint(db, feature.id);
      await knowledge.update(
        "feature",
        feature.id,
        { name: "Актуальная цель" },
        { actor: "Автор", ifRevision: feature.revision },
      );

      const page = readRelationNeighborhood(db, {
        ref: checkpoint.id,
        depth: 1,
        direction: "outgoing",
        type: "references",
      });

      expect(checkpoint.data.references[0]?.title).toBe("Исходная цель");
      expect(page.edges).toHaveLength(1);
      expect(page.edges[0]?.to).toEqual({ id: feature.id, kind: "feature" });
      expect(page.nodes.find((node) => node.ref.id === feature.id)?.title).toBe("Актуальная цель");
    });
  });

  test("отсутствующая цель references считается повреждением, а не допустимым пустым отношением", async () => {
    await withGraphViewFixture(async (db) => {
      const knowledge = new KnowledgeService(db);
      const feature = await knowledge.create("feature", { name: "Цель" }, "Автор");
      const checkpoint = await createReferencedCheckpoint(db, feature.id);
      const id = crypto.randomUUID();
      // Намеренно повреждённый снимок ссылки: подпись есть, но постоянной цели нет.
      db.insert({
        ...checkpoint,
        id,
        key: `CP-${id}`,
        data: {
          ...checkpoint.data,
          references: [
            {
              id: crypto.randomUUID(),
              kind: "feature",
              key: "missing",
              title: "Подпись не заменяет цель",
            },
          ],
        },
      });

      let failure: unknown;
      try {
        readRelationNeighborhood(db, { ref: id });
      } catch (error) {
        failure = error;
      }

      expect(failure).toMatchObject({ code: "CORRUPT_DATA", details: { id, field: "references" } });
    });
  });
  test("повреждённая текущая цель не исчезает из успешного графа", async () => {
    await withGraphViewFixture(async (db) => {
      const knowledge = new KnowledgeService(db);
      const document = await knowledge.create(
        "document",
        { name: "Документ", body: "Текст" },
        "Автор",
      );
      // Storage обходит предметную проверку цели только для воспроизведения повреждения.
      db.update(
        {
          ...document,
          revision: document.revision + 1,
          data: {
            ...document.data,
            relations: [
              {
                target: { kind: "feature", id: crypto.randomUUID() },
                type: "documents",
                description: "",
              },
            ],
          },
        },
        document.revision,
      );
      const generation = db.getGeneration();

      let failure: unknown;
      try {
        readRelationNeighborhood(db, { ref: document.id });
      } catch (error) {
        failure = error;
      }

      expect(failure).toMatchObject({
        code: "CORRUPT_DATA",
        details: { id: document.id, field: "documents" },
      });
      expect(db.getGeneration()).toBe(generation);
    });
  });
  test("сохранённые отношения, границы глубины и owner CAS не требуют тел документов", async () => {
    await withGraphViewFixture(async (db) => {
      const knowledge = new KnowledgeService(db);
      const feature = await knowledge.create("feature", { name: "Цель" }, "Автор");
      const first = await knowledge.create(
        "document",
        { name: "Первый", body: "BODY-SENTINEL" },
        "Автор",
      );
      const second = await knowledge.create(
        "document",
        { name: "Второй", body: "SECOND-BODY" },
        "Автор",
      );
      const linked = await knowledge.linkDocument(first.id, feature.id, {
        type: "documents",
        description: "Назначение",
        actor: "Автор",
        ifRevision: first.revision,
      });
      await knowledge.linkDocument(second.id, first.id, {
        type: "references",
        actor: "Автор",
        ifRevision: second.revision,
      });

      const page = readRelationNeighborhood(db, {
        ref: feature.id,
        direction: "incoming",
        depth: 1,
      });

      expect(page.nodes.map((node) => node.ref.id).sort()).toEqual([feature.id, first.id].sort());
      expect(page.edges).toHaveLength(1);
      expect(page.edges[0]).toMatchObject({
        from: { kind: "document", id: first.id },
        to: { kind: "feature", id: feature.id },
        type: "documents",
        description: "Назначение",
        revision: linked.revision,
      });
      expect(page.boundary).toEqual([{ kind: "document", id: first.id }]);
      expect(page.depthLimited).toBe(true);
      expect(JSON.stringify(page)).not.toContain("BODY-SENTINEL");
      expect(JSON.stringify(db.listGraphSources("relations"))).not.toContain("SECOND-BODY");
    });
  });

  test("разные окна одного поколения не теряют endpoints, а старое поколение отклоняется", async () => {
    await withGraphViewFixture(async (db) => {
      const knowledge = new KnowledgeService(db);
      const feature = await knowledge.create("feature", { name: "Цель" }, "Автор");
      const document = await knowledge.create(
        "document",
        { name: "Описание", body: "Текст" },
        "Автор",
      );
      await knowledge.linkDocument(document.id, feature.id, {
        actor: "Автор",
        ifRevision: document.revision,
      });
      db.rename(feature.id, "new-feature-key", feature.revision, "Автор");

      const first = readRelationNeighborhood(db, { ref: `feature:${feature.key}`, limit: 1 });
      const second = readRelationNeighborhood(db, {
        ref: feature.id,
        offset: first.nextOffset ?? 0,
        limit: 1,
        generation: first.generation,
      });

      expect(first.root).toEqual({ id: feature.id, kind: "feature" });
      expect(new Set([...first.nodes, ...second.nodes].map((node) => node.ref.id)).size).toBe(2);
      for (const edge of first.edges) {
        const available = [...first.nodes, ...first.endpoints].map((node) => node.ref.id);
        expect(available).toContain(edge.from.id);
        expect(available).toContain(edge.to.id);
      }
      await knowledge.create("feature", { name: "Новое поколение" }, "Автор");
      expect(() =>
        readRelationNeighborhood(db, { ref: feature.id, offset: 1, generation: first.generation }),
      ).toThrow();
      try {
        readRelationNeighborhood(db, { offset: 1, generation: first.generation });
      } catch (error) {
        expect(error).toMatchObject({ code: "PAGE_CHANGED" });
      }
    });
  });
});
