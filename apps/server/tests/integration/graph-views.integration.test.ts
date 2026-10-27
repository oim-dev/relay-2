import { describe, expect, test } from "bun:test";
import { HistoryService, KnowledgeService } from "@relay/core";
import { createRelayClient } from "@relay/rest-sdk";
import { withGraphViewServer } from "./graph-views-fixture";

describe("Компактные HTTP-проекции через REST SDK", () => {
  test("timeline передаёт ограниченное окно и отклоняет смешанное поколение", async () => {
    await withGraphViewServer(async (url, projectId, db) => {
      const history = new HistoryService(db);
      const root = await history.start({ title: "История", description: "PRIVATE-BODY" }, "Автор");
      await history.start({ title: "Соседняя работа" }, "Автор");
      const generation = db.getGeneration();
      const endpoint = `${url}/api/v2/projects/${projectId}/history/timeline`;
      const client = createRelayClient({ baseUrl: url });

      const body = await client.read(projectId, "historyTimeline", { query: { limit: 1 } });

      expect(body).toMatchObject({
        ok: true,
        data: {
          generation,
          total: 2,
          nextOffset: 1,
          items: [expect.objectContaining({ kind: "session-created", checkpointId: null })],
        },
      });
      expect(body.data.items).toHaveLength(1);
      expect(JSON.stringify(body)).not.toContain("PRIVATE-BODY");
      const selected = await client.read(projectId, "historyTimeline", {
        query: { session: `work-session:${root.key}`, limit: 1 },
      });
      expect(selected).toMatchObject({
        ok: true,
        data: { total: 1, items: [expect.objectContaining({ sessionId: root.id })] },
      });
      const next = await client.read(projectId, "historyTimeline", {
        query: { offset: 1, limit: 1, generation },
      });
      expect(next.data.items).toHaveLength(1);
      expect(next.data.items[0]?.sessionId).not.toBe(body.data.items[0]?.sessionId);
      expect(next.data.nextOffset).toBeNull();
      await history.start({ title: "Новое поколение" }, "Автор");
      await expect(
        client.read(projectId, "historyTimeline", { query: { offset: 1, generation } }),
      ).rejects.toMatchObject({ code: "PAGE_CHANGED", status: 409 });
      const missingGeneration = await fetch(`${endpoint}?offset=1`);
      expect(missingGeneration.status).toBe(400);
      expect(await missingGeneration.json()).toMatchObject({
        ok: false,
        error: { code: "INVALID_ARGUMENT" },
      });
    });
  });

  test("соседство разрешает dot ref через query и ограничивает выдачу компоненты", async () => {
    await withGraphViewServer(async (url, projectId, db) => {
      const knowledge = new KnowledgeService(db);
      const feature = await knowledge.create("feature", { name: "Цель" }, "Автор");
      const document = await knowledge.create(
        "document",
        { name: "Документ", body: "PRIVATE-DOCUMENT" },
        "Автор",
      );
      await knowledge.linkDocument(document.id, feature.id, {
        actor: "Автор",
        ifRevision: document.revision,
      });
      db.rename(feature.id, ".", feature.revision, "Автор");
      const endpoint = `${url}/api/v2/projects/${projectId}/relation-neighborhood`;
      const client = createRelayClient({ baseUrl: url });

      const body = await client.read(projectId, "relationNeighborhood", {
        query: { ref: ".", component: true, limit: 1 },
      });

      expect(body).toMatchObject({
        ok: true,
        data: {
          root: { id: feature.id, kind: "feature" },
          totalNodes: 2,
          totalEdges: 1,
          nextOffset: 1,
          paths: [],
          edges: [
            expect.objectContaining({
              from: { id: document.id, kind: "document" },
              to: { id: feature.id, kind: "feature" },
              revision: 2,
            }),
          ],
        },
      });
      expect(body.data.nodes).toHaveLength(1);
      expect(JSON.stringify(body)).not.toContain("PRIVATE-DOCUMENT");
      const next = await client.read(projectId, "relationNeighborhood", {
        query: { ref: ".", component: true, offset: 1, limit: 1, generation: body.data.generation },
      });
      expect(next.data.nodes).toHaveLength(1);
      expect(next.data.nodes[0]?.ref.id).not.toBe(body.data.nodes[0]?.ref.id);
      expect(next.data.nextOffset).toBeNull();
      await knowledge.create("feature", { name: "Новое поколение" }, "Автор");
      await expect(
        client.read(projectId, "relationNeighborhood", {
          query: { ref: ".", component: true, offset: 1, generation: body.data.generation },
        }),
      ).rejects.toMatchObject({ code: "PAGE_CHANGED", status: 409 });
      const invalid = await fetch(`${endpoint}?ref=.&depth=101`);
      expect(invalid.status).toBe(400);
      expect(await invalid.json()).toMatchObject({
        ok: false,
        error: { code: "INVALID_ARGUMENT" },
      });
    });
  });
});
