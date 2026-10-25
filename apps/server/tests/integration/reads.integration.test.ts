import { describe, expect, test } from "bun:test";
import { KnowledgeService, TasksService } from "@relay/core";
import { withServer, apiError } from "./fixture";

describe("Согласованные Nest read-проекции", () => {
  test("страницы сохраняют total и generation, а внешняя запись отклоняет продолжение", async () => {
    await withServer(async ({ client, location, database }) => {
      await database(async (db) => {
        const knowledge = new KnowledgeService(db);
        await knowledge.create("document", { name: "А", body: "Текст А", pinned: false }, "CLI");
        await knowledge.create("document", { name: "Б", body: "Текст Б", pinned: false }, "CLI");
      });
      const first = await client.entities(location.projectId, {
        kind: "document",
        limit: 1,
        pinned: false,
        section: "none",
      });
      const second = await client.entities(location.projectId, {
        kind: "document",
        limit: 1,
        offset: 1,
        generation: first.data.generation,
      });
      const empty = await client.entities(location.projectId, {
        kind: "document",
        offset: 20,
        generation: first.data.generation,
      });

      expect(first.data).toMatchObject({ total: 2, nextOffset: 1 });
      expect(second.data).toMatchObject({
        total: 2,
        nextOffset: null,
        generation: first.data.generation,
      });
      expect(second.data.items[0]?.id).not.toBe(first.data.items[0]?.id);
      expect(empty.data).toMatchObject({ items: [], total: 2, nextOffset: null });
      await database((db) =>
        new KnowledgeService(db).create("document", { name: "Внешний", body: "CLI" }, "CLI"),
      );
      await apiError(
        () =>
          client.entities(location.projectId, {
            kind: "document",
            offset: 1,
            generation: first.data.generation,
          }),
        "PAGE_CHANGED",
        409,
      );
      await apiError(
        () => client.entities(location.projectId, { kind: "document", offset: 1 }),
        "INVALID_ARGUMENT",
        400,
      );
      await apiError(
        () => client.entities(location.projectId, { kind: "document", ["__proto__"]: "x" }),
        "INVALID_ARGUMENT",
        400,
      );
      const status = await client.read(location.projectId, "projectStatus", {});
      const check = await client.read(location.projectId, "projectCheck", {});
      expect(check.data).toMatchObject({
        projectId: location.projectId,
        generation: status.data.generation,
        records: status.data.records,
        valid: true,
        issues: [],
      });
      expect((await client.overview(location.projectId)).data.counts.document).toBe(3);
    });
  });

  test("root=true/false и full/summary getMany сохраняют фильтры, union и per-item ошибки", async () => {
    await withServer(async ({ client, location, database }) => {
      const root = await database((db) =>
        new TasksService(db).create({ title: "Корневая" }, "CLI"),
      );
      const child = await database((db) =>
        new TasksService(db).create({ title: "Дочерняя", parent: root.id }, "CLI"),
      );

      expect(
        (await client.entities(location.projectId, { kind: "task", root: true })).data.items.map(
          (item) => item.id,
        ),
      ).toEqual([root.id]);
      expect(
        (await client.entities(location.projectId, { kind: "task", root: false })).data.total,
      ).toBe(2);
      await apiError(
        () => client.entities(location.projectId, { kind: "task", root: true, parent: root.id }),
        "INVALID_ARGUMENT",
        400,
      );
      const selection = await client.read(location.projectId, "getMany", {
        query: { ref: [root.id, "absent", child.id], summary: true, withVersions: true },
      });
      expect(selection.data.view).toBe("summary");
      expect(selection.data.items[1]).toMatchObject({
        ref: "absent",
        ok: false,
        error: { code: "NOT_FOUND" },
      });
      expect(selection.meta?.versions?.[root.id]?.aggregateVersion).toBeTypeOf("string");
      expect(
        (await client.read(location.projectId, "taskChildren", { ref: root.id })).data.map(
          (item) => item.id,
        ),
      ).toEqual([child.id]);
      expect(
        (
          await client.read(location.projectId, "search", {
            query: { q: "Дочерняя", kind: "task" },
          })
        ).data.map((item) => item.id),
      ).toEqual([child.id]);
    });
  });

  test("все task/plan/release проекции сохраняют владельца, состав и прогресс Core", async () => {
    await withServer(async ({ client, location }) => {
      const result = await client.batch(location.projectId, {
        actor: "Web",
        operationKey: "planning",
        commands: [
          { op: "task.create", as: "dependency", input: { title: "Предшественник" } },
          {
            op: "task.create",
            as: "task",
            input: { title: "Приёмка", dependencies: [{ $ref: "dependency" }] },
          },
          {
            op: "task.criterion.add",
            as: "criterion",
            ref: { $ref: "task" },
            ifRevision: { $revision: "task" },
            input: { title: "Проверено" },
          },
          {
            op: "task.link",
            ref: { $ref: "task" },
            ifRevision: { $revision: "criterion" },
            input: { target: { $ref: "dependency" } },
          },
          { op: "task.comment.add", ref: { $ref: "task" }, input: { body: "Независимый журнал" } },
          { op: "plan.create", as: "plan", input: { title: "План" } },
          {
            op: "plan.stage.create",
            as: "stage",
            ref: { $ref: "plan" },
            ifRevision: { $revision: "plan" },
            input: { title: "Этап" },
          },
          {
            op: "plan.stage.task.add",
            ref: { $ref: "plan" },
            ifRevision: { $revision: "stage" },
            input: { stageId: { $ref: "stage" }, task: { $ref: "task" } },
          },
          {
            op: "release.create",
            input: { title: "Поставка", version: "1.0", planIds: [{ $ref: "plan" }] },
          },
        ],
      });
      const task = result.data.entities.find(
        (item) => item.kind === "task" && item.data.title === "Приёмка",
      );
      const plan = result.data.entities.find((item) => item.kind === "work-plan");
      const release = result.data.entities.find((item) => item.kind === "release");
      const stage = plan?.data.stages[0];
      if (
        task === undefined ||
        plan === undefined ||
        release === undefined ||
        stage === undefined
      ) {
        throw new Error("Не получен связанный результат пакета");
      }

      const comments = await client.read(location.projectId, "taskComments", { ref: task.id });
      const criteria = await client.read(location.projectId, "taskCriteria", { ref: task.id });
      const comment = comments.data.items[0];
      const criterion = criteria.data.items[0];
      if (comment === undefined || criterion === undefined) {
        throw new Error("Нет вложенного элемента задачи");
      }
      expect(comments.data).toMatchObject({
        revision: task.revision,
        items: [{ body: "Независимый журнал", createdBy: "Web" }],
      });
      expect(
        (await client.read(location.projectId, "taskComment", { ref: task.id, id: comment.id }))
          .data,
      ).toEqual(comment);
      expect(
        (await client.read(location.projectId, "taskCriterion", { ref: task.id, id: criterion.id }))
          .data,
      ).toEqual(criterion);
      expect(criterion.title).toBe("Проверено");
      expect(
        (
          await client.read(location.projectId, "taskDependencies", { ref: task.id })
        ).data.items.map((item) => item.data.title),
      ).toEqual(["Предшественник"]);
      expect(
        (await client.read(location.projectId, "taskRelated", { ref: task.id })).data.map(
          (item) => item.data.title,
        ),
      ).toEqual(["Предшественник"]);
      expect(
        (await client.read(location.projectId, "taskProgress", { ref: task.id })).data.canComplete,
      ).toBe(false);
      expect(
        (
          await client.read(location.projectId, "planStageTasks", {
            ref: plan.id,
            stageId: stage.id,
          })
        ).data.items.map((item) => item.id),
      ).toEqual([task.id]);
      expect(
        (await client.read(location.projectId, "planStages", { ref: plan.id })).data,
      ).toMatchObject({ revision: plan.revision, items: [{ id: stage.id }] });
      expect(
        (await client.read(location.projectId, "planStage", { ref: plan.id, stageId: stage.id }))
          .data,
      ).toMatchObject({ revision: plan.revision, stage: { id: stage.id } });
      expect(
        (await client.read(location.projectId, "planProgress", { ref: plan.id })).data,
      ).toMatchObject({ completed: false, canComplete: false });
      expect(
        (await client.read(location.projectId, "releasePlans", { ref: release.id })).data.items.map(
          (item) => item.id,
        ),
      ).toEqual([plan.id]);
      expect(
        (await client.read(location.projectId, "releaseProgress", { ref: release.id })).data,
      ).toMatchObject({
        completed: false,
        canRelease: false,
        plans: [{ id: plan.id, completed: false }],
      });
      const memberships = await client.read(location.projectId, "taskMemberships", {
        ref: task.id,
      });
      expect(memberships.data).toMatchObject({
        task: task.key,
        items: [{ plan: plan.key, revision: plan.revision, stage: { id: stage.id } }],
      });
    });
  });

  test("разделы, связи и участие после заполнения сохраняют точные ID и своих владельцев", async () => {
    await withServer(async ({ client, location, database }) => {
      const document = await database((db) =>
        new KnowledgeService(db).create("document", { name: "Знание", body: "Текст" }, "CLI"),
      );
      const app = await database((db) =>
        new KnowledgeService(db).create("application", { name: "Приложение", slug: "app" }, "CLI"),
      );

      expect((await client.read(location.projectId, "documentSections", {})).data).toMatchObject({
        items: [],
      });
      expect(
        (await client.read(location.projectId, "documentLinks", { ref: document.id })).data,
      ).toMatchObject({ revision: document.revision, items: [] });
      expect(
        (await client.read(location.projectId, "applicationParticipation", { ref: app.id })).data,
      ).toMatchObject({ application: app.key, revision: app.revision, items: [] });

      const { project, feature, linked, application, implementation, emptyDocument, emptyApp } =
        await database(async (db) => {
          const knowledge = new KnowledgeService(db);
          const project = await knowledge.changeSection(
            "create",
            { id: "guides", name: "Руководства" },
            { actor: "CLI", ifRevision: knowledge.get("project").revision },
          );
          const feature = await knowledge.create("feature", { name: "Поиск" }, "CLI");
          const linked = await knowledge.linkDocument(document.id, feature.id, {
            actor: "CLI",
            ifRevision: document.revision,
            type: "documents",
            description: "Правила поиска",
          });
          const implementation = await knowledge.create(
            "implementation",
            { title: "Поиск в приложении", application: app.id, target: feature.id },
            "CLI",
          );
          const emptyDocument = await knowledge.create(
            "document",
            { name: "Без связей", body: "Другой владелец" },
            "CLI",
          );
          const emptyApp = await knowledge.create(
            "application",
            { name: "Без участия", slug: "empty" },
            "CLI",
          );
          return {
            project,
            feature,
            linked,
            application: knowledge.get("application", app.id),
            implementation,
            emptyDocument,
            emptyApp,
          };
        });

      const sections = await client.read(location.projectId, "documentSections", {});
      const links = await client.read(location.projectId, "documentLinks", { ref: document.id });
      const participation = await client.read(location.projectId, "applicationParticipation", {
        ref: app.id,
      });

      expect(sections.data).toEqual({
        project: project.key,
        revision: project.revision,
        items: [{ id: "guides", name: "Руководства" }],
      });
      expect(links.data).toEqual({
        ref: document.key,
        revision: linked.revision,
        items: [
          {
            target: { kind: "feature", id: feature.id },
            type: "documents",
            description: "Правила поиска",
          },
        ],
      });
      expect(participation.data).toEqual({
        application: app.key,
        revision: application.revision,
        items: [implementation],
      });
      expect(
        (await client.read(location.projectId, "documentLinks", { ref: emptyDocument.id })).data,
      ).toEqual({ ref: emptyDocument.key, revision: emptyDocument.revision, items: [] });
      expect(
        (await client.read(location.projectId, "applicationParticipation", { ref: emptyApp.id }))
          .data,
      ).toEqual({ application: emptyApp.key, revision: emptyApp.revision, items: [] });
    });
  });

  test("history endpoints возвращают обычные массивы, актуальный run, контекст и исходный материал", async () => {
    await withServer(async ({ client, location }) => {
      const started = await client.command(location.projectId, {
        op: "session.start",
        input: { title: "Исследование" },
        actor: "Web",
        operationKey: "session",
      });
      const session = started.data.entities.find((item) => item.kind === "work-session");
      if (session === undefined) {
        throw new Error("Нет сессии");
      }
      const opened = await client.command(location.projectId, {
        op: "checkpoint.open",
        ref: session.id,
        ifRevision: session.revision,
        input: { title: "Намерение", body: "Исследовать", runId: session.data.currentRunId },
        actor: "Web",
        operationKey: "intent",
      });
      const checkpoint = opened.data.entities.find((item) => item.kind === "work-checkpoint");
      if (checkpoint === undefined) {
        throw new Error("Нет материала");
      }

      expect(
        (await client.read(location.projectId, "historyCheckpoint", { ref: checkpoint.id })).data,
      ).toEqual(checkpoint);
      expect(
        (
          await client.read(location.projectId, "historyCheckpoints", {
            query: { session: session.id },
          })
        ).data.map((item) => item.id),
      ).toEqual([checkpoint.id]);
      expect(
        (
          await client.read(location.projectId, "historySessions", { query: { root: true } })
        ).data.map((item) => item.id),
      ).toEqual([session.id]);
      expect(
        (await client.read(location.projectId, "historySession", { ref: session.id })).data,
      ).toMatchObject({ id: session.id, data: { currentRunId: session.data.currentRunId } });
      expect(
        (await client.read(location.projectId, "historyTree", { ref: session.id })).data.map(
          (item) => item.id,
        ),
      ).toEqual([session.id]);
      expect(
        (
          await client.read(location.projectId, "historyIntents", {
            ref: session.id,
            query: { includeChildren: true },
          })
        ).data.map((item) => item.id),
      ).toEqual([checkpoint.id]);
      expect(
        (await client.read(location.projectId, "historyContext", { ref: session.id })).data,
      ).toMatchObject({ session: { id: session.id } });
    });
  });
});
