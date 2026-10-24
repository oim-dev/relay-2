import { describe, expect, test } from "bun:test";
import { KnowledgeService, ReplicationService } from "@relay/core";
import { openProject } from "@relay/project-runtime";
import { withProcessFixture } from "./process-fixture";

describe("Соединение request остаётся открытым до завершения one-shot", () => {
  test("manual now и refresh завершают асинхронный owner до outer database.close", async () => {
    await withProcessFixture(async (fixture) => {
      const context = fixture.context("request-lifetime");
      const project = openProject(context.options);
      const document = await new KnowledgeService(project.database).create(
        "document",
        { name: "Дождаться", body: "данные сохранены" },
        "author",
      );
      project.database.close();
      expect(
        (await fixture.request(context.options, "connect", { remote: fixture.remote })).ok,
      ).toBe(true);

      const now = await fixture.request(context.options, "now");
      const refreshed = await fixture.request(context.options, "status", { refresh: true });

      expect(now).toMatchObject({ ok: true, data: { pending: { changesets: 0 } } });
      expect(refreshed).toMatchObject({ ok: true, data: { pending: { changesets: 0 } } });
      const reopened = openProject(context.options);
      try {
        expect(new ReplicationService(reopened.database).status().pending).toBe(0);
        expect(reopened.database.get(document.id)?.data.body).toBe("данные сохранены");
      } finally {
        reopened.database.close();
      }
    });
  }, 20_000);
});
