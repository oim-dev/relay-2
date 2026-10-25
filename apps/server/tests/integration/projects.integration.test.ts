import { describe, expect, test } from "bun:test";
import { copyFile, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { initializeProject, initializeWorkspace, registerProject } from "@relay/project-runtime";
import { createRelayClient } from "@relay/rest-sdk";
import { startRelayServer } from "../../src/server";
import { withServer, apiError } from "./fixture";

describe("Nest Runtime scope", () => {
  test("workspace обслуживает независимые базы и сохраняет недоступную регистрацию", async () => {
    await withServer(async ({ runtime, directory, location }) => {
      const other = initializeProject({
        ...runtime,
        cwd: join(directory, "other"),
        name: "Второй",
      });
      const unavailable = initializeProject({
        ...runtime,
        cwd: join(directory, "unavailable"),
        name: "Недоступный",
      });
      const workspace = { ...runtime, cwd: join(directory, "workspace") };
      initializeWorkspace(workspace);
      registerProject(workspace, "первый", runtime.cwd);
      registerProject(workspace, "второй", join(directory, "other"));
      registerProject(workspace, "нет базы", join(directory, "unavailable"));
      await rm(unavailable.databasePath);
      const server = await startRelayServer({
        runtime: workspace,
        version: "test",
        actor: "Web",
        port: 0,
      });
      const client = createRelayClient({ baseUrl: server.url });
      try {
        expect((await client.context()).data).toMatchObject({
          mode: "workspace",
          projects: [
            { id: location.projectId, available: true },
            { id: other.projectId, available: true },
            { id: null, name: "нет базы", available: false },
          ],
        });
        await client.command(location.projectId, {
          op: "document.create",
          input: { name: "Локальный", body: "Только первый" },
          actor: "Web",
          operationKey: "isolation",
        });
        expect((await client.entities(other.projectId, { kind: "document" })).data.total).toBe(0);
        await apiError(() => client.entity(other.projectId, "DOC-1"), "NOT_FOUND", 404);
      } finally {
        await server.close();
      }
    });
  });

  test("две физические реплики одного ID отклоняются до bind", async () => {
    await withServer(async ({ runtime, directory, location }) => {
      const clone = join(directory, "clone");
      await mkdir(clone);
      const databasePath = join(clone, "replica.sqlite");
      await copyFile(location.databasePath, databasePath);
      await writeFile(
        join(clone, "relay.config.json"),
        JSON.stringify({ version: 1, projectId: location.projectId, databasePath }),
      );
      const workspace = { ...runtime, cwd: join(directory, "workspace") };
      initializeWorkspace(workspace);
      registerProject(workspace, "исходная", runtime.cwd);
      registerProject(workspace, "копия", clone);

      await expect(
        startRelayServer({ runtime: workspace, version: "test", actor: "Web", port: 0 }),
      ).rejects.toMatchObject({ code: "SERVER_PROJECT_AMBIGUOUS", exitCode: 4 });
    });
  });

  test("перепривязка проекта отвергает Git Sync до процессного вызова", async () => {
    let requests = 0;
    await withServer(
      async ({ runtime, directory, location, client }) => {
        const other = initializeProject({
          ...runtime,
          cwd: join(directory, "other"),
          name: "Другой",
        });
        await writeFile(
          location.configPath,
          JSON.stringify({ version: 1, projectId: other.projectId }),
        );

        await apiError(() => client.gitSyncNow(location.projectId), "PROJECT_CHANGED", 409);
        expect(requests).toBe(0);
      },
      {
        gitSync: {
          request: async () => {
            requests += 1;
            return {};
          },
        },
      },
    );
  });
});
