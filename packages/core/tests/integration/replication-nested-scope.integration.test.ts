import { describe, expect, test } from "bun:test";
import type { WorkPlanRecord } from "@relay/contracts";
import { BatchService } from "../../src/batch/batch";
import { HistoryService } from "../../src/history/history";
import { KnowledgeService } from "../../src/knowledge/knowledge";
import { PlanningService } from "../../src/planning/planning";
import { ReplicationService } from "../../src/replication/replication";
import { TasksService } from "../../src/tasks/tasks";
import {
  nestedScopeSource,
  replaceNestedTextEffect,
  withNestedScopeFixture,
} from "./helpers/nested-scope-fixture";
import {
  redigestSource,
  unverifiedSourcePublication,
} from "./helpers/replication-publication-fixture";

/**
 * Выбирает этап по известному заголовку fixture без подстановки первого элемента.
 */
function stageId(plan: WorkPlanRecord, title: string): string {
  const stage = plan.data.stages.find((entry) => entry.title === title);
  if (stage === undefined) {
    throw new Error(`Нет этапа ${title}`);
  }
  return stage.id;
}

/**
 * Создаёт только два пустых этапа; возвращает исходную ревизию для последующей явной команды теста.
 */
async function twoStagePlan(plans: PlanningService, title = "План"): Promise<WorkPlanRecord> {
  const plan = await plans.create("work-plan", { title }, "seed");
  const first = await plans.stage(
    plan.id,
    "create",
    { title: "A" },
    { actor: "seed", ifRevision: plan.revision },
  );
  return plans.stage(
    plan.id,
    "create",
    { title: "B" },
    { actor: "seed", ifRevision: first.revision },
  );
}

describe("Semantic scope вложенных целей публикации", () => {
  test("stage.update с targets A и эффектом B атомарно отклоняется до receipt/base/outbox", async () => {
    await withNestedScopeFixture(
      async (db) => {
        await twoStagePlan(new PlanningService(db));
      },
      async ({ first, second, remote }) => {
        const plan = new PlanningService(first).get("work-plan", "PLN-1");
        const selectedId = stageId(plan, "A");
        const otherId = stageId(plan, "B");
        await new BatchService(first).execute(
          {
            version: 1,
            operations: [
              {
                op: "plan.stage.update",
                ref: plan.id,
                ifRevision: plan.revision,
                input: { stageId: selectedId, title: "Новый A" },
              },
            ],
          },
          { actor: "author", operationKey: "stage-scope" },
        );
        const source = nestedScopeSource(first);
        const other = remote.components?.find(
          (part) => part.ownerId === plan.id && part.kind === "plan-stage" && part.id === otherId,
        );
        if (other?.kind !== "plan-stage") {
          throw new Error("Нет части B");
        }
        const damaged = replaceNestedTextEffect(source, selectedId, other);
        const incoming = unverifiedSourcePublication(remote, damaged);
        await new KnowledgeService(second).create(
          "document",
          { name: "Локальный pending", body: "Сохранить при отказе" },
          "local",
        );
        const sync = new ReplicationService(second);
        const before = sync.capture();
        const state = second.getReplicationState();
        const guard = second.getReplicationGuard();
        const outbox = second.getReplicationOutbox();

        expect(() => sync.accept(incoming)).toThrow(
          expect.objectContaining({ code: "INVALID_TRANSITION" }),
        );

        expect(
          new PlanningService(second)
            .get("work-plan", plan.id)
            .data.stages.map((stage) => stage.title),
        ).toEqual(["A", "B"]);
        expect(sync.capture()).toEqual(before);
        expect(second.getReplicationState()).toEqual(state);
        expect(second.getReplicationGuard()).toEqual(guard);
        expect(second.getReplicationOutbox()).toEqual(outbox);
        expect(second.getBatchReceipt("stage-scope")).toBeUndefined();
        expect(first.getReplicationOutbox()).toEqual([source]);
      },
    );
  });

  test("batch update A → update A → title сохраняет независимый точечный update B", async () => {
    await withNestedScopeFixture(
      async (db) => {
        await twoStagePlan(new PlanningService(db));
      },
      async ({ first, second, remote }) => {
        const plan = new PlanningService(first).get("work-plan", "PLN-1");
        const a = stageId(plan, "A");
        const b = stageId(plan, "B");
        await new BatchService(first).execute(
          {
            version: 1,
            operations: [
              {
                op: "plan.stage.update",
                as: "first",
                ref: plan.id,
                ifRevision: plan.revision,
                input: { stageId: a, title: "A: шаг 1" },
              },
              {
                op: "plan.stage.update",
                as: "second",
                ref: plan.id,
                ifRevision: { $revision: "first" },
                input: { stageId: a, title: "A: шаг 2", summary: "Текст A" },
              },
              {
                op: "plan.update",
                ref: plan.id,
                ifRevision: { $revision: "second" },
                input: { title: "Новый заголовок плана" },
              },
            ],
          },
          { actor: "left", operationKey: "scoped-multi-step" },
        );
        const source = nestedScopeSource(first);
        const remotePlan = new PlanningService(second).get("work-plan", plan.id);
        const remoteAfter = await new PlanningService(second).stage(
          plan.id,
          "update",
          { stageId: b, title: "Удалённый B", summary: "Текст B" },
          { actor: "right", ifRevision: remotePlan.revision },
        );
        const peer = new ReplicationService(second);
        const published = peer.prepare(remote).snapshot;
        peer.accept(published);
        const remoteB = second
          .getComponents([plan.id])
          .find((part) => part.kind === "plan-stage" && part.id === b);

        const merged = new ReplicationService(first).prepare(published);
        expect(merged.conflicts).toEqual([]);
        peer.accept(merged.snapshot);

        const saved = new PlanningService(second).get("work-plan", plan.id);
        expect(saved.data.title).toBe("Новый заголовок плана");
        expect(saved.data.stages.map(({ id, title, summary }) => ({ id, title, summary }))).toEqual(
          [
            { id: a, title: "A: шаг 2", summary: "Текст A" },
            { id: b, title: "Удалённый B", summary: "Текст B" },
          ],
        );
        expect(saved.createdBy).toBe("seed");
        const localAfter = new PlanningService(first).get("work-plan", plan.id);
        expect([
          { updatedBy: "left", updatedAt: localAfter.updatedAt },
          { updatedBy: "right", updatedAt: remoteAfter.updatedAt },
        ]).toContainEqual({ updatedBy: saved.updatedBy, updatedAt: saved.updatedAt });
        expect(
          second
            .getComponents([plan.id])
            .find((part) => part.kind === "plan-stage" && part.id === b),
        ).toEqual(remoteB);
        expect(source.transitions?.map((step) => step.targets?.primaryId)).toEqual([a, a, plan.id]);
        expect(second.getBatchReceipt("scoped-multi-step")).toEqual(source.receipts[0]);
      },
    );
  });

  test("transfer внутри плана и между владельцами допускает связанные эффекты и последующее снятие пустого этапа", async () => {
    await withNestedScopeFixture(
      async (db) => {
        const tasks = new TasksService(db);
        const selected = await tasks.create({ title: "Переносимая" }, "seed");
        const retained = await tasks.create({ title: "Остаётся" }, "seed");
        const plans = new PlanningService(db);
        let source = await twoStagePlan(plans, "Источник");
        const a = stageId(source, "A");
        source = await plans.stageTask(source.id, a, selected.id, false, {
          actor: "seed",
          ifRevision: source.revision,
        });
        await plans.stageTask(source.id, a, retained.id, false, {
          actor: "seed",
          ifRevision: source.revision,
        });
        await twoStagePlan(plans, "Получатель");
      },
      async ({ first, second, remote }) => {
        const plans = new PlanningService(first);
        const source = plans.get("work-plan", "PLN-1");
        const target = plans.get("work-plan", "PLN-2");
        const selected = new TasksService(first).get("PRODUCT-1");
        const retained = new TasksService(first).get("PRODUCT-2");
        const sourceB = stageId(source, "B");
        await new BatchService(first).execute(
          {
            version: 1,
            operations: [
              {
                op: "plan.stage.task.transfer",
                as: "inside",
                ref: source.id,
                ifRevision: source.revision,
                input: {
                  task: selected.id,
                  targetPlan: source.id,
                  targetStage: sourceB,
                  targetRevision: source.revision,
                  reason: "В другой этап",
                },
              },
              {
                op: "plan.stage.task.transfer",
                as: "outside",
                ref: source.id,
                ifRevision: { $revision: "inside" },
                input: {
                  task: selected.id,
                  targetPlan: target.id,
                  targetStage: stageId(target, "A"),
                  targetRevision: target.revision,
                  reason: "В другой план",
                },
              },
              {
                op: "plan.stage.remove",
                ref: source.id,
                ifRevision: { $revision: "outside" },
                input: { stageId: sourceB },
              },
            ],
          },
          { actor: "author", operationKey: "scoped-transfers" },
        );
        const changeset = nestedScopeSource(first);

        const prepared = new ReplicationService(first).prepare(remote);
        expect(prepared.conflicts).toEqual([]);
        new ReplicationService(second).accept(prepared.snapshot);

        const savedSource = new PlanningService(second).get("work-plan", source.id);
        const savedTarget = new PlanningService(second).get("work-plan", target.id);
        expect(savedSource.data.stages.map(({ id, taskIds }) => ({ id, taskIds }))).toEqual([
          { id: stageId(source, "A"), taskIds: [retained.id] },
        ]);
        expect(savedTarget.data.stages.map(({ id, taskIds }) => ({ id, taskIds }))).toEqual([
          { id: stageId(target, "A"), taskIds: [selected.id] },
          { id: stageId(target, "B"), taskIds: [] },
        ]);
        expect(new TasksService(second).get(selected.id).data).toEqual(selected.data);
        expect(second.getBatchReceipt("scoped-transfers")).toEqual(changeset.receipts[0]);
      },
    );
  });

  test("section.update с targets A и эффектом B не импортирует чужое имя или receipt", async () => {
    await withNestedScopeFixture(
      async (db) => {
        await new BatchService(db).execute(
          {
            version: 1,
            operations: [
              {
                op: "document.section.create",
                as: "a",
                ifRevision: 1,
                input: { id: "A", name: "Раздел A" },
              },
              {
                op: "document.section.create",
                ifRevision: { $revision: "a" },
                input: { id: "B", name: "Раздел B" },
              },
            ],
          },
          { actor: "seed", operationKey: "sections" },
        );
      },
      async ({ first, second, remote }) => {
        const project = new KnowledgeService(first).get("project", first.projectId);
        await new BatchService(first).execute(
          {
            version: 1,
            operations: [
              {
                op: "document.section.update",
                ifRevision: project.revision,
                input: { id: "A", name: "Новый A" },
              },
            ],
          },
          { actor: "author", operationKey: "section-scope" },
        );
        const source = nestedScopeSource(first);
        const other = remote.components?.find(
          (part) =>
            part.ownerId === first.projectId && part.kind === "document-section" && part.id === "B",
        );
        if (other?.kind !== "document-section") {
          throw new Error("Нет раздела B");
        }
        const damaged = replaceNestedTextEffect(source, "A", other);
        const incoming = unverifiedSourcePublication(remote, damaged);
        const sync = new ReplicationService(second);
        const before = sync.capture();
        const state = second.getReplicationState();
        const guard = second.getReplicationGuard();

        expect(() => sync.accept(incoming)).toThrow(
          expect.objectContaining({ code: "INVALID_STATE" }),
        );

        expect(
          new KnowledgeService(second).get("project", second.projectId).data.documentSections,
        ).toEqual([
          { id: "A", name: "Раздел A" },
          { id: "B", name: "Раздел B" },
        ]);
        expect(sync.capture()).toEqual(before);
        expect(second.getReplicationState()).toEqual(state);
        expect(second.getReplicationGuard()).toEqual(guard);
        expect(second.getReplicationOutbox()).toEqual([]);
        expect(second.getBatchReceipt("section-scope")).toBeUndefined();
      },
    );
  });

  test("правка раздела A поверх независимого B сохраняет B, а снятие A оставляет историческую ссылку документа", async () => {
    await withNestedScopeFixture(
      async (db) => {
        const knowledge = new KnowledgeService(db);
        const project = knowledge.get("project", db.projectId);
        const a = await knowledge.changeSection(
          "create",
          { id: "A", name: "Раздел A" },
          { actor: "seed", ifRevision: project.revision },
        );
        await knowledge.changeSection(
          "create",
          { id: "B", name: "Раздел B" },
          { actor: "seed", ifRevision: a.revision },
        );
        await knowledge.create(
          "document",
          { name: "Исторический раздел", body: "Текст", sectionId: "A" },
          "seed",
        );
      },
      async ({ first, second, remote }) => {
        const project = new KnowledgeService(first).get("project", first.projectId);
        await new BatchService(first).execute(
          {
            version: 1,
            operations: [
              {
                op: "document.section.update",
                as: "updated",
                ifRevision: project.revision,
                input: { id: "A", name: "Новый A" },
              },
              {
                op: "document.section.move",
                as: "moved",
                ifRevision: { $revision: "updated" },
                input: { id: "A", last: true },
              },
              {
                op: "document.section.remove",
                ifRevision: { $revision: "moved" },
                input: { id: "A" },
              },
            ],
          },
          { actor: "left", operationKey: "section-lifecycle" },
        );
        const source = nestedScopeSource(first);
        const remoteProject = new KnowledgeService(second).get("project", second.projectId);
        await new KnowledgeService(second).changeSection(
          "update",
          { id: "B", name: "Удалённый B" },
          { actor: "right", ifRevision: remoteProject.revision },
        );
        const peer = new ReplicationService(second);
        const published = peer.prepare(remote).snapshot;
        peer.accept(published);

        const merged = new ReplicationService(first).prepare(published);
        expect(merged.conflicts).toEqual([]);
        peer.accept(merged.snapshot);

        const saved = new KnowledgeService(second).get("project", second.projectId);
        expect(saved.data.documentSections).toEqual([{ id: "B", name: "Удалённый B" }]);
        expect(saved.data.retiredDocumentSectionIds).toEqual(["A"]);
        expect(second.get("DOC-1")?.data.sectionId).toBe("A");
        expect(second.getBatchReceipt("section-lifecycle")).toEqual(source.receipts[0]);
      },
    );
  });

  test("resume не объявляет прежний run результатом нового участия", async () => {
    await withNestedScopeFixture(
      async (db) => {
        const history = new HistoryService(db);
        const session = await history.start({ title: "Сессия" }, "author");
        await history.transition(
          session.id,
          "pause",
          { runId: session.data.currentRunId, reason: "Пауза" },
          { actor: "author", ifRevision: session.revision },
        );
      },
      async ({ first, second, remote }) => {
        const history = new HistoryService(first);
        const session = history.list()[0];
        const oldRun = session?.data.runs[0];
        if (session === undefined || oldRun === undefined) {
          throw new Error("Нет сессии fixture");
        }
        await new BatchService(first).execute(
          {
            version: 1,
            operations: [
              {
                op: "session.resume",
                ref: session.id,
                ifRevision: session.revision,
                input: {},
              },
            ],
          },
          { actor: "author", operationKey: "run-scope" },
        );
        const source = nestedScopeSource(first);
        if (source.transitions === undefined) {
          throw new Error("Нет ленты resume");
        }
        const damaged = redigestSource({
          ...source,
          transitions: source.transitions.map((step) => {
            if (step.targets === undefined) {
              throw new Error("Нет targets resume");
            }
            return {
              ...step,
              targets: { ...step.targets, roles: { ...step.targets.roles, run: oldRun.id } },
            };
          }),
        });
        const sync = new ReplicationService(second);
        const before = sync.capture();
        const state = second.getReplicationState();

        expect(() => sync.accept(unverifiedSourcePublication(remote, damaged))).toThrow(
          expect.objectContaining({ code: "CONFLICT" }),
        );

        expect(new HistoryService(second).get(session.id).data.currentRunId).toBeNull();
        expect(sync.capture()).toEqual(before);
        expect(second.getReplicationState()).toEqual(state);
        expect(second.getBatchReceipt("run-scope")).toBeUndefined();
        const good = new ReplicationService(first).prepare(remote);
        expect(good.conflicts).toEqual([]);
        sync.accept(good.snapshot);
        const saved = new HistoryService(second).get(session.id);
        expect(saved.data.runs[0]).toEqual(oldRun);
        expect(saved.data.currentRunId).toBe(history.get(session.id).data.currentRunId);
        expect(saved.data.currentRunId).not.toBe(oldRun.id);
        expect(second.getBatchReceipt("run-scope")).toEqual(source.receipts[0]);
      },
    );
  });
});
