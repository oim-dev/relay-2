import { describe, expect, test } from "bun:test";
import { appendFile, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createConnection } from "node:net";
import {
  acquireServerInstance,
  createServerClient,
  createServerLaunch,
  initializeProject,
} from "@relay/project-runtime";
import { version } from "../../package.json";
import { deadline } from "../process/process-fixture";
import { startDevelopmentServer, withDevelopmentSource } from "./development-fixture";

// Два ready-барьера, HTTP и shutdown имеют собственные deadlines; runner оставляет время cleanup.
const WATCH_TEST_TIMEOUT_MS = 45_000;

/**
 * Проверяет отсутствие listener через отказ TCP, не путая TIME_WAIT с занятым bind-портом.
 * Socket принадлежит helper и закрывается при любом исходе, включая deadline.
 */
async function expectListenerClosed(url: string): Promise<void> {
  const address = new URL(url);
  const socket = createConnection({ host: address.hostname, port: Number(address.port) });
  try {
    const error = await deadline(
      new Promise<Error>((resolve, reject) => {
        socket.once("error", resolve);
        socket.once("connect", () => reject(new Error("После остановки Server принимает TCP")));
      }),
      2000,
    );
    expect(error).toMatchObject({ code: "ECONNREFUSED" });
  } finally {
    socket.destroy();
  }
}

describe("Source Server в dev-сессии", () => {
  test(
    "без Web dist обслуживает исходный проект, reload сохраняет UUID, EOF завершает watcher и lease",
    async () => {
      await withDevelopmentSource(async (source) => {
        const runtime = {
          cwd: join(source.directory, "playground"),
          home: join(source.directory, "home"),
        };
        const project = initializeProject({
          ...runtime,
          name: "Существующий dev-проект",
          slug: "dev-project",
        });
        const config = await readFile(project.configPath, "utf8");
        const webUrl = "http://127.0.0.1:5174";
        const launch = createServerLaunch(runtime, {
          version,
          mode: "foreground",
          port: 0,
          actor: "Автор dev",
          development: { webUrl },
        });
        const savedLaunch = await readFile(launch.path, "utf8");
        const client = createServerClient({
          cwd: runtime.cwd,
          env: {},
          userHome: source.directory,
          executablePath: process.execPath,
          version,
        });
        expect(await Bun.file(join(source.directory, "apps/web/dist/index.html")).exists()).toBe(
          false,
        );
        const server = startDevelopmentServer(source, launch);
        try {
          const first = await server.nextReady();
          const context = await fetch(new URL("/api/v2/context", first.url), {
            headers: { Origin: webUrl },
            signal: AbortSignal.timeout(2000),
          });

          expect(first.instanceId).toBe(launch.instanceId);
          expect(context.status).toBe(200);
          expect(await context.json()).toMatchObject({
            ok: true,
            data: { actor: "Автор dev", projects: [{ id: project.projectId, available: true }] },
          });
          const foreign = await fetch(new URL("/api/v2/context", first.url), {
            headers: { Origin: "http://127.0.0.1:5175" },
            signal: AbortSignal.timeout(2000),
          });
          expect(foreign.status).toBe(403);
          expect(await foreign.json()).toMatchObject({ error: { code: "ORIGIN_FORBIDDEN" } });
          expect(await client.list(runtime)).toMatchObject({
            registered: 1,
            running: 1,
            items: [
              { instanceId: launch.instanceId, bootId: first.bootId, development: { webUrl } },
            ],
          });

          // Меняем только копию уже загруженного entry после барьера ready, без restart API.
          await appendFile(
            join(source.serverDirectory, "src/main.ts"),
            "\n// Reload изолированной dev-fixture.\n",
          );
          const reloaded = await server.nextReady();

          expect(reloaded.instanceId).toBe(first.instanceId);
          expect(reloaded.bootId).not.toBe(first.bootId);
          expect(await readFile(launch.path, "utf8")).toBe(savedLaunch);
          expect(await client.list(runtime)).toMatchObject({
            registered: 1,
            running: 1,
            items: [
              {
                instanceId: launch.instanceId,
                state: "ready",
                bootId: reloaded.bootId,
                development: { webUrl },
              },
            ],
          });
          const afterReload = await fetch(new URL("/api/v2/context", reloaded.url), {
            signal: AbortSignal.timeout(2000),
          });
          expect(afterReload.status).toBe(200);
          expect(await afterReload.json()).toMatchObject({
            data: { projects: [{ id: project.projectId }] },
          });

          server.child.stdin.end();
          const exitCode = await deadline(server.child.exited, 5000);

          expect(exitCode).toBe(0);
          expect(await client.list(runtime)).toMatchObject({
            registered: 1,
            running: 0,
            items: [
              {
                instanceId: launch.instanceId,
                state: "stopped",
                bootId: null,
                development: { webUrl },
              },
            ],
          });
          expect(await Bun.file(join(dirname(launch.path), "endpoint.json")).exists()).toBe(false);
          acquireServerInstance(launch).close();
          await expectListenerClosed(reloaded.url);
          expect(await readFile(project.configPath, "utf8")).toBe(config);
        } finally {
          await server.dispose();
        }
      });
    },
    WATCH_TEST_TIMEOUT_MS,
  );

  test(
    "авария watcher оставляет stale с исходной dev metadata, а не stopped или ready",
    async () => {
      await withDevelopmentSource(async (source) => {
        const runtime = {
          cwd: join(source.directory, "playground"),
          home: join(source.directory, "home"),
        };
        initializeProject(runtime);
        const development = { webUrl: "http://127.0.0.1:5174" };
        const launch = createServerLaunch(runtime, { version, mode: "foreground", development });
        const client = createServerClient({
          cwd: runtime.cwd,
          env: {},
          userHome: source.directory,
          executablePath: process.execPath,
          version,
        });
        const server = startDevelopmentServer(source, launch);
        try {
          const ready = await server.nextReady();

          server.child.kill("SIGKILL");
          await deadline(server.child.exited, 5000);
          const list = await client.list(runtime);

          expect(list).toMatchObject({
            running: 0,
            registered: 1,
            items: [
              { instanceId: launch.instanceId, bootId: ready.bootId, state: "stale", development },
            ],
          });
          await expectListenerClosed(ready.url);
        } finally {
          await server.dispose();
        }
      });
    },
    WATCH_TEST_TIMEOUT_MS,
  );
});
