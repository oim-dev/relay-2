import { describe, expect, test } from "bun:test";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  acquireServerInstance,
  createServerClient,
  createServerLaunch,
  initializeWorkspace,
  listServerInstances,
  readServerLaunch,
  registerProject,
  resolveServerScope,
  type ServerEnvironment,
} from "@relay/project-runtime";
import { version } from "../../package.json";
import { withCliFixture } from "./helpers/cli-fixture";
import { spawnServerTestProcess } from "./helpers/server-process";
import type { ServerTestProcess } from "./helpers/server-process.types";

const group = "server-web/lifecycle/fixtures";

/**
 * Даёт проверяемому клиенту явный изолированный home/cwd без влияния на process.env теста.
 */
function environment(cwd: string): ServerEnvironment {
  return {
    cwd,
    env: {},
    userHome: cwd,
    executablePath: process.execPath,
    version,
    readinessTimeoutMs: 2000,
  };
}

describe("Реестр серверов и защищённый lifecycle", () => {
  test("устаревший bootstrap не может объявить новую версию из заменённого launch", async () => {
    await withCliFixture(async (cli) => {
      cli.createProject();
      const launch = createServerLaunch(
        { cwd: cli.runtime.cwd, home: String(cli.runtime.env.RELAY_HOME) },
        { version, mode: "foreground" },
      );
      writeFileSync(launch.path, JSON.stringify({ ...launch, version: "new-release" }));

      expect(() => acquireServerInstance(launch)).toThrow(
        expect.objectContaining({ code: "SERVER_LAUNCH_CHANGED" }),
      );

      const fresh = acquireServerInstance(readServerLaunch(launch.path));
      fresh.close();
      expect((await listServerInstances(launch.options, environment(cli.root))).running).toBe(0);
    }, group);
  });

  test("два реальных сервера видны через CLI; stop одного сохраняет второй и секреты не выходят в JSON", async () => {
    await withCliFixture(async (cli) => {
      const project = cli.createProject();
      const options = { cwd: cli.runtime.cwd, home: String(cli.runtime.env.RELAY_HOME) };
      const first = createServerLaunch(options, {
        version,
        mode: "foreground",
        actor: "точный автор",
      });
      const second = createServerLaunch(options, { version, mode: "foreground" });
      expect(second.actor).toBe("web");
      let one: ServerTestProcess | undefined;
      let two: ServerTestProcess | undefined;
      try {
        one = await spawnServerTestProcess(first);
        two = await spawnServerTestProcess(second);
        const client = createServerClient(environment(cli.root));
        const initial = await cli.success(["server", "list"], { server: client });
        expect(initial.data).toMatchObject({ running: 2, registered: 2 });
        const statuses = await client.list(options);
        expect(statuses.items.map((item) => item.pid).sort()).toEqual(
          [one.child.pid, two.child.pid].sort(),
        );
        expect(
          statuses.items.every(
            (item) => item.state === "ready" && item.projects[0]?.id === project.projectId,
          ),
        ).toBe(true);
        const privateEndpoint = JSON.parse(
          readFileSync(join(dirname(first.path), "endpoint.json"), "utf8"),
        );
        expect(JSON.stringify(initial.data)).not.toContain(privateEndpoint.nonce);
        const ambiguous = await cli.error(["server", "open"], 4, { server: client });
        expect(ambiguous.code).toBe("SERVER_AMBIGUOUS");

        const stopped = await cli.success(["server", "stop", "--instance", first.instanceId], {
          server: client,
        });

        expect(stopped.data).toMatchObject({
          instanceId: first.instanceId,
          state: "stopped",
          pid: null,
        });
        expect(await one.child.exited).toBe(0);
        const remaining = await client.list(options);
        expect(remaining.running).toBe(1);
        expect(remaining.items.find((item) => item.instanceId === second.instanceId)).toMatchObject(
          { state: "ready", pid: two.child.pid },
        );
        expect(two.child.exitCode).toBeNull();
      } finally {
        await Promise.all([one?.close(), two?.close()]);
      }
    }, group);
  });

  test("control отвергает неверный nonce, другой boot и браузерный Origin без остановки владельца", async () => {
    await withCliFixture(async (cli) => {
      cli.createProject();
      const options = { cwd: cli.runtime.cwd, home: String(cli.runtime.env.RELAY_HOME) };
      const launch = createServerLaunch(options, { version, mode: "foreground" });
      const owner = await spawnServerTestProcess(launch);
      try {
        const endpoint = JSON.parse(
          readFileSync(join(dirname(launch.path), "endpoint.json"), "utf8"),
        );
        const url = `http://127.0.0.1:${endpoint.controlPort}/control/${launch.instanceId}/${endpoint.bootId}/stop`;

        const wrong = await fetch(url, {
          method: "POST",
          headers: { authorization: "Bearer wrong" },
        });
        const origin = await fetch(url, {
          method: "POST",
          headers: { authorization: `Bearer ${endpoint.nonce}`, origin: "http://example.test" },
        });
        const oldBoot = await fetch(url.replace(endpoint.bootId, "old-boot"), {
          method: "POST",
          headers: { authorization: `Bearer ${endpoint.nonce}` },
        });

        expect([wrong.status, origin.status, oldBoot.status]).toEqual([403, 403, 404]);
        expect((await listServerInstances(options, environment(cli.root))).running).toBe(1);
        const endpointPath = join(dirname(launch.path), "endpoint.json");
        writeFileSync(endpointPath, JSON.stringify({ ...endpoint, nonce: "0".repeat(64) }));
        expect(await listServerInstances(options, environment(cli.root))).toMatchObject({
          running: 0,
          items: [{ instanceId: launch.instanceId, state: "unresponsive", pid: owner.child.pid }],
        });
        writeFileSync(endpointPath, JSON.stringify(endpoint));
        expect(owner.child.exitCode).toBeNull();
        expect(() => acquireServerInstance(launch)).toThrow(
          expect.objectContaining({ code: "LOCAL_LOCK_BUSY" }),
        );
      } finally {
        await owner.close();
      }
    }, group);
  });

  test("crash оставляет stale, а подставленный чужой PID никогда не становится целью stop", async () => {
    await withCliFixture(async (cli) => {
      cli.createProject();
      const options = { cwd: cli.runtime.cwd, home: String(cli.runtime.env.RELAY_HOME) };
      const launch = createServerLaunch(options, { version, mode: "foreground" });
      const innocentLaunch = createServerLaunch(options, { version, mode: "foreground" });
      let owner: ServerTestProcess | undefined;
      let innocent: ServerTestProcess | undefined;
      try {
        owner = await spawnServerTestProcess(launch);
        innocent = await spawnServerTestProcess(innocentLaunch);
        owner.child.kill("SIGKILL");
        await owner.child.exited;
        const endpointPath = join(dirname(launch.path), "endpoint.json");
        const stale = JSON.parse(readFileSync(endpointPath, "utf8"));
        writeFileSync(endpointPath, JSON.stringify({ ...stale, pid: innocent.child.pid }));
        const client = createServerClient(environment(cli.root));

        const observed = await client.list(options, launch.instanceId);
        expect(observed).toMatchObject({
          running: 0,
          items: [{ state: "stale", pid: innocent.child.pid }],
        });
        const stopped = await client.stop(options, launch.instanceId);

        expect(stopped.state).toBe("stopped");
        expect(innocent.child.exitCode).toBeNull();
        expect((await client.list(options, innocentLaunch.instanceId)).running).toBe(1);
      } finally {
        await Promise.all([owner?.close(), innocent?.close()]);
      }
    }, group);
  });

  test("workspace сохраняет ошибочную регистрацию и отвергает один ID двух физических БД", async () => {
    await withCliFixture(async (cli) => {
      const first = cli.createProject();
      const workspace = join(cli.root, "workspace");
      mkdirSync(workspace);
      const options = { cwd: workspace, home: String(cli.runtime.env.RELAY_HOME) };
      initializeWorkspace(options);
      registerProject(options, "first", cli.runtime.cwd);
      const path = join(workspace, "relay.workspace.json");
      const config = JSON.parse(readFileSync(path, "utf8"));
      config.projects.push({ name: "missing", path: "../missing" });
      writeFileSync(path, JSON.stringify(config));

      const result = resolveServerScope(options);

      expect(result.scope.kind).toBe("workspace");
      expect(result.projects).toMatchObject([
        { id: first.projectId, available: true },
        { id: null, name: "missing", available: false, error: { code: "CONFIG_NOT_FOUND" } },
      ]);
      const other = join(cli.root, "replica");
      mkdirSync(other);
      copyFileSync(first.databasePath, join(other, "copy.sqlite"));
      writeFileSync(
        join(other, "relay.config.json"),
        JSON.stringify({ version: 1, projectId: first.projectId, databasePath: "copy.sqlite" }),
      );
      config.projects.push({ name: "replica", path: other });
      writeFileSync(path, JSON.stringify(config));

      expect(() => resolveServerScope(options)).toThrow(
        expect.objectContaining({ code: "SERVER_PROJECT_AMBIGUOUS" }),
      );
    }, group);
  });
});
