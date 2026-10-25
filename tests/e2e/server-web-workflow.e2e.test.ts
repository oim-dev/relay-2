import { describe, expect, test } from "bun:test";
import { RelayApiError } from "@relay/rest-sdk";
import { createGitSyncFixture } from "./helpers/git-sync-fixture";
import { startWorkflowServer, WorkflowServerCleanupError } from "./helpers/server-fixture";
import { invokeRecord, invokeSuccess } from "./helpers/workflow-fixture";
import type { WorkflowServer } from "./helpers/server-fixture.types";

describe("Совместная работа поставляемых Server, CLI и Git Sync", () => {
  test("Web поставляется в бинарнике, REST сохраняет исходные версии и доставляет запись второй реплике", async () => {
    const fixture = await createGitSyncFixture();
    let server: WorkflowServer | undefined;
    const failures: unknown[] = [];
    let preserveFixture = false;
    try {
      await invokeSuccess(fixture.a, fixture.a.cwd, [
        "init",
        "--name",
        "Общий проект",
        "--slug",
        "shared",
      ]);
      server = await startWorkflowServer(fixture.a, fixture.a.cwd);
      const { client, url, fetch: fetchServer } = server;
      const context = await client.context();
      const projectId = context.data.projects[0]?.id;
      if (projectId === undefined || projectId === null) {
        throw new Error("Сервер должен показать инициализированный проект");
      }
      const page = await fetchServer(`${url}/projects/${projectId}/documents`, {
        headers: { Accept: "text/html" },
      });
      expect(page.status).toBe(200);
      expect(page.headers.get("content-type")).toContain("text/html");
      const html = await page.text();
      const asset = /src="([^"]+\.js)"/.exec(html)?.[1];
      if (asset === undefined) {
        throw new Error("Встроенный HTML должен ссылаться на production JavaScript Vite");
      }
      const assetUrl = new URL(asset, page.url);
      expect(assetUrl.origin).toBe(url);
      const script = await fetchServer(assetUrl);
      expect(script.status).toBe(200);
      expect(script.headers.get("content-type")).toMatch(/javascript/);
      expect((await script.text()).length).toBeGreaterThan(0);

      // Допустимый предметный ключ не должен превращаться в навигацию URL-пути.
      const operationKey = "..";
      const body =
        "# Общий документ\n\n  Отступ и Markdown\n\n```ts\nconst value = '$HOME';\n```\n";
      const command = {
        op: "document.create",
        input: { name: "Материал из Web", body },
        actor: "Человек",
        operationKey,
      };
      const created = await client.command(projectId, command);
      const document = created.data.entities.find((entry) => entry.kind === "document");
      if (document === undefined) {
        throw new Error("Квитанция должна содержать созданный документ");
      }
      expect(document.createdBy).toBe("Человек");
      const fromCli = await invokeRecord(fixture.a, fixture.a.cwd, [
        "document",
        "get",
        document.id,
      ]);
      expect(fromCli).toMatchObject({ id: document.id, createdBy: "Человек", data: { body } });
      const read = await client.entity(projectId, document.id, { withVersions: true });
      const version = read.meta?.versions?.[document.id]?.aggregateVersion;
      if (version === undefined) {
        throw new Error("Версионное чтение должно содержать исходный aggregateVersion");
      }

      const current = await invokeRecord(fixture.a, fixture.a.cwd, [
        "document",
        "update",
        document.id,
        "--body",
        "Уточнение через CLI\n",
        "--actor",
        "Агент",
        "--if-revision",
        String(document.revision),
      ]);
      let failure: unknown;
      try {
        await client.command(projectId, {
          op: "document.update",
          ref: document.id,
          expectedVersion: version,
          input: { body: "Устаревший черновик" },
          actor: "Человек",
          operationKey: crypto.randomUUID(),
        });
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(RelayApiError);
      expect(failure).toMatchObject({ status: 409, code: "VERSION_CONFLICT" });
      const replay = await client.command(projectId, command);
      expect(replay.data).toEqual({ ...created.data, replayed: true });
      expect((await client.receipt(projectId, operationKey)).data).toEqual(replay.data);
      const preserved = await client.entity(projectId, document.id);
      if (preserved.data.kind !== "document") {
        throw new Error("Адрес документа должен сохранить свой предметный вид");
      }
      expect(preserved.data.data.body).toBe("Уточнение через CLI\n");
      expect(preserved.data.revision).toBe(current.revision);
      expect(preserved.data.updatedBy).toBe("Агент");

      await invokeSuccess(fixture.a, fixture.a.cwd, [
        "git-sync",
        "connect",
        "--remote",
        fixture.remote,
      ]);
      const before = (await client.read(projectId, "gitSyncStatus", {})).data;
      expect(before.connected).toBe(true);
      expect(before.pending.changesets).toBeGreaterThan(0);
      const exchange = await client.gitSyncNow(projectId);
      expect(exchange.data.state).toBe("completed");
      const outcome = await client.read(projectId, "gitSyncRequest", {
        requestId: exchange.data.requestId,
      });
      expect(outcome.data).toEqual(exchange.data);
      const after = (await client.read(projectId, "gitSyncStatus", {})).data;
      expect(after.pending.changesets).toBe(0);
      expect(after.lastSuccess).not.toBeNull();
      await invokeSuccess(fixture.b, fixture.b.cwd, [
        "git-sync",
        "restore",
        "--remote",
        fixture.remote,
      ]);
      const delivered = await invokeRecord(fixture.b, fixture.b.cwd, [
        "document",
        "get",
        document.id,
      ]);
      expect(delivered.id).toBe(document.id);
      expect(delivered.data.body).toBe("Уточнение через CLI\n");
    } catch (error) {
      failures.push(error);
      preserveFixture = error instanceof WorkflowServerCleanupError;
    } finally {
      try {
        await server?.close();
      } catch (error) {
        failures.push(error);
        preserveFixture = true;
      }
      if (!preserveFixture) {
        try {
          await fixture.close();
        } catch (error) {
          failures.push(error);
        }
      }
    }
    if (failures.length > 0) {
      throw new AggregateError(
        failures,
        preserveFixture
          ? `Маршрут завершился с ошибкой; Server fixture сохранён: ${fixture.root}`
          : "Ошибка маршрута Server/CLI/Git Sync либо его очистки",
      );
    }
  }, 120_000);
});
