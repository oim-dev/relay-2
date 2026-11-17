import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  acquireServerInstance,
  createServerLaunch,
  initializeProject,
  listServerInstances,
  readServerLaunch,
} from "@relay/project-runtime";
import { RuntimeFixture } from "./helpers/runtime-fixture";

const invalidLaunches = [
  { name: "native-служба", mode: "service", webUrl: "http://127.0.0.1:5174" },
  { name: "внешний Web URL", mode: "foreground", webUrl: "https://example.test" },
] as const;

describe("Dev metadata в launch и control Server", () => {
  let fixture: RuntimeFixture;

  beforeEach(() => {
    fixture = new RuntimeFixture("dev-mode-test-review/fixtures");
  });

  afterEach(async () => {
    await fixture.dispose();
  });

  test.each(invalidLaunches)(
    "$name отклоняется до публикации dev-регистрации",
    ({ mode, webUrl }) => {
      const options = { cwd: fixture.cwd, home: fixture.home };
      initializeProject(options);

      expect(() =>
        createServerLaunch(options, { version: "test", mode, development: { webUrl } }),
      ).toThrow(expect.objectContaining({ code: "INVALID_ARGUMENT", exitCode: 2 }));

      expect(existsSync(join(fixture.home, "servers"))).toBe(false);
    },
  );

  test("повреждённая сохранённая metadata не становится обычным foreground launch", () => {
    const options = { cwd: fixture.cwd, home: fixture.home };
    initializeProject(options);
    const launch = createServerLaunch(options, { version: "test", mode: "foreground" });
    writeFileSync(
      launch.path,
      JSON.stringify({ ...launch, development: { webUrl: "file:///untrusted" } }),
    );

    expect(() => readServerLaunch(launch.path)).toThrow(
      expect.objectContaining({ code: "SERVER_REGISTRY_INVALID", exitCode: 4 }),
    );
  });

  test("authenticated control stop отказывает dev и оставляет ready-владельца с тем же boot", async () => {
    const options = { cwd: fixture.cwd, home: fixture.home };
    initializeProject(options);
    const launch = createServerLaunch(options, {
      version: "test",
      mode: "foreground",
      development: { webUrl: "http://127.0.0.1:5174" },
    });
    const registration = acquireServerInstance(launch);
    let stopCalls = 0;
    try {
      registration.ready({
        url: "http://127.0.0.1:3210",
        projects: [],
        /**
         * Наблюдает запрос остановки без подмены настоящего control listener и SQLite lease.
         */
        onStop(): void {
          stopCalls += 1;
        },
      });
      const endpointPath = join(dirname(launch.path), "endpoint.json");
      const savedEndpoint = readFileSync(endpointPath, "utf8");
      const endpoint: unknown = JSON.parse(savedEndpoint);
      if (
        endpoint === null ||
        typeof endpoint !== "object" ||
        !("bootId" in endpoint) ||
        typeof endpoint.bootId !== "string" ||
        !("nonce" in endpoint) ||
        typeof endpoint.nonce !== "string" ||
        !("controlPort" in endpoint) ||
        typeof endpoint.controlPort !== "number"
      ) {
        throw new Error("Не опубликована control capability dev-регистрации");
      }
      const url = `http://127.0.0.1:${endpoint.controlPort}/control/${launch.instanceId}/${endpoint.bootId}`;

      const stopped = await fetch(`${url}/stop`, {
        method: "POST",
        headers: { authorization: `Bearer ${endpoint.nonce}` },
        signal: AbortSignal.timeout(2000),
      });
      const status = await fetch(`${url}/health`, {
        headers: { authorization: `Bearer ${endpoint.nonce}` },
        signal: AbortSignal.timeout(2000),
      });

      expect(stopped.status).toBe(409);
      expect(await stopped.json()).toMatchObject({ code: "SERVER_DEVELOPMENT_MANAGED" });
      expect(status.status).toBe(200);
      expect(await status.json()).toMatchObject({
        data: { state: "ready", bootId: endpoint.bootId, development: launch.development },
      });
      expect(stopCalls).toBe(0);
      expect(readFileSync(endpointPath, "utf8")).toBe(savedEndpoint);
      expect(() => acquireServerInstance(launch)).toThrow(
        expect.objectContaining({ code: "LOCAL_LOCK_BUSY" }),
      );
    } finally {
      registration.close();
    }
    expect(existsSync(join(dirname(launch.path), "endpoint.json"))).toBe(false);
  });

  test("изменённый Vite URL не подтверждает готовность старого health", async () => {
    const options = { cwd: fixture.cwd, home: fixture.home };
    initializeProject(options);
    const launch = createServerLaunch(options, {
      version: "test",
      mode: "foreground",
      development: { webUrl: "http://127.0.0.1:5174" },
    });
    const registration = acquireServerInstance(launch);
    try {
      registration.ready({
        url: "http://127.0.0.1:3210",
        projects: [],
        /**
         * Остановка не вызывается сценарием наблюдения; ресурс закрывается в finally.
         */
        onStop(): void {},
      });
      writeFileSync(
        launch.path,
        JSON.stringify({ ...launch, development: { webUrl: "http://127.0.0.1:5175" } }),
      );

      const list = await listServerInstances(options, {
        cwd: fixture.cwd,
        env: {},
        userHome: fixture.root,
        executablePath: process.execPath,
        version: "test",
      });

      expect(list).toMatchObject({ running: 0, registered: 1, items: [{ state: "incompatible" }] });
    } finally {
      registration.close();
    }
  });
});
