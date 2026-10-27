import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { initializeProject } from "@relay/project-runtime";
import { createRelayClient, RelayApiError } from "@relay/rest-sdk";
import { startRelayServer } from "../../src/server";

describe("Компактные HTTP-проекции задач", () => {
  test("SDK передаёт фильтры и refs, сохраняет сводку и отвергает смену поколения", async () => {
    const parent = resolve(
      import.meta.dir,
      "../../../../.artifacts",
      new Date().toISOString().slice(0, 10),
      "task-view-fixtures",
    );
    await mkdir(parent, { recursive: true });
    const directory = await mkdtemp(join(parent, "http-"));
    const runtime = { cwd: join(directory, "project"), home: join(directory, "home") };
    const location = initializeProject({ ...runtime, name: "HTTP проекции", slug: "task-views" });
    const server = await startRelayServer({
      runtime,
      actor: "HTTP автор",
      version: "test",
      port: 0,
    });
    const client = createRelayClient({ baseUrl: server.url });
    const project = location.projectId;
    try {
      const result = await client.batch(project, {
        actor: "HTTP автор",
        operationKey: crypto.randomUUID(),
        commands: [
          {
            op: "task.create",
            as: "dependency",
            input: { board: "product", title: "Зависимость", column: "ready" },
          },
          {
            op: "task.create",
            as: "blocked",
            input: {
              board: "product",
              title: "Ожидающая",
              column: "ready",
              dependencies: [{ $ref: "dependency" }],
            },
          },
          {
            op: "task.create",
            as: "done",
            input: {
              board: "product",
              title: "Выполненная",
              column: "done",
              description: "НЕ_ПЕРЕДАВАТЬ_В_СПИСОК",
            },
          },
          { op: "plan.create", as: "plan", input: { title: "План" } },
          {
            op: "plan.stage.create",
            ref: { $ref: "plan" },
            as: "stage",
            ifRevision: { $revision: "plan" },
            input: { title: "Этап" },
          },
          {
            op: "plan.stage.task.add",
            ref: { $ref: "plan" },
            ifRevision: { $revision: "stage" },
            input: { stageId: { $ref: "stage" }, task: { $ref: "dependency" } },
          },
        ],
      });
      const dependency = result.data.items[0]!.id;
      const blocked = result.data.items[1]!.id;
      const done = result.data.items[2]!.id;

      const first = await client.read(project, "taskViews", {
        query: { board: "product", limit: 1 },
      });

      expect(first.data.items.map((item) => item.id)).toEqual([dependency]);
      expect(first.data.total).toBe(3);
      expect(first.data.counts).toMatchObject({
        total: 3,
        completed: 1,
        blocked: 1,
        columns: { ready: 2, done: 1 },
      });
      const subset = await client.read(project, "taskViews", {
        query: { refs: [blocked, done], limit: 2 },
      });
      expect(subset.data.items.map((item) => item.id)).toEqual([blocked, done]);
      expect(subset.data.items[0]?.progress.blockers).toEqual([dependency]);
      expect(JSON.stringify(subset.data)).not.toContain("НЕ_ПЕРЕДАВАТЬ_В_СПИСОК");
      const ready = await client.read(project, "taskViews", { query: { readiness: "ready" } });
      expect(ready.data.items.map((item) => item.id)).toEqual([dependency]);
      const candidates = await client.read(project, "taskCandidates", {
        query: { availableOnly: true, limit: 1 },
      });
      expect(candidates.data.total).toBe(2);
      expect(candidates.data.items.map((item) => item.id)).toEqual([blocked]);
      const next = await client.read(project, "taskViews", {
        query: { offset: 1, limit: 1, generation: first.data.generation },
      });
      expect(next.data.items.map((item) => item.id)).toEqual([blocked]);
      await client.command(project, {
        op: "task.comment.add",
        ref: dependency,
        input: { body: "Изменение поколения" },
        actor: "HTTP автор",
        operationKey: crypto.randomUUID(),
      });
      try {
        await client.read(project, "taskViews", {
          query: { offset: 1, generation: first.data.generation },
        });
        throw new Error("Ожидался PAGE_CHANGED");
      } catch (error) {
        expect(error).toBeInstanceOf(RelayApiError);
        if (!(error instanceof RelayApiError)) {
          throw error;
        }
        expect(error.code).toBe("PAGE_CHANGED");
        expect(error.status).toBe(409);
      }
    } finally {
      await server.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
