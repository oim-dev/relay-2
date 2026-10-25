import { describe, expect, test } from "bun:test";
import { once } from "node:events";
import { chmod, copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createConnection, createServer, type Socket } from "node:net";
import { dirname, join, resolve } from "node:path";
import {
  acquireServerInstance,
  createServerLaunch,
  initializeProject,
  openProject,
  type ServerLaunch,
} from "@relay/project-runtime";
import { BatchService, KnowledgeService } from "@relay/core";
import { createWebEmbedding } from "../../scripts/embedding";
import { OPTIONAL_NEST_EXTENSIONS } from "../../scripts/compile-options";
import { REQUEST_GRACE_MS, SHUTDOWN_DEADLINE_MS } from "../../src/process/shutdown";
import { deadline, startChild, stopChild } from "./process-fixture";
import type { ServerChild } from "./process-fixture.types";

const repository = resolve(import.meta.dir, "../../../..");

/**
 * Подтверждает, что реальный lifetime mutex ещё удерживается процессом Server.
 */
function expectBusy(launch: ServerLaunch): void {
  expect(() => {
    const unexpected = acquireServerInstance(launch);
    unexpected.close();
  }).toThrow(expect.objectContaining({ code: "LOCAL_LOCK_BUSY" }));
}

/**
 * Собственный каталог процесса. Альтернативный binary нужен для адресной сборки,
 * не затрагивающей shared dist во время параллельного root check родителя.
 */
async function withShutdownBinary(
  action: (directory: string, binary: string) => Promise<void>,
  fault?: "blocked-writer",
): Promise<void> {
  const parent = join(
    repository,
    ".artifacts",
    new Date().toISOString().slice(0, 10),
    "server-web/nest-server/shutdown/process",
  );
  await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(join(parent, "shutdown-"));
  const binary = join(
    directory,
    process.platform === "win32" ? "relay-server.exe" : "relay-server",
  );
  try {
    if (fault === "blocked-writer") {
      const entry = join(directory, "blocked-writer.ts");
      // Отказ внедряется только в этот child: настоящий production main/shutdown остаётся неизменным.
      await writeFile(
        entry,
        `
import { createConnection } from "node:net";
import { once } from "node:events";
import { BatchService } from ${JSON.stringify(join(repository, "packages/core/src/index.ts"))};
BatchService.prototype.execute = async function () {
  const probe = createConnection({ host: "127.0.0.1", port: Number(process.env.RELAY_TEST_PROBE_PORT) });
  await once(probe, "connect");
  process.stdin.once("end", () => setImmediate(() => probe.write("draining\\n")));
  probe.write("started\\n");
  return await new Promise<never>(() => {});
};
await import(${JSON.stringify(join(repository, "apps/server/src/main.ts"))});
`,
      );
      const embedding = createWebEmbedding(join(repository, "apps/web/dist"));
      const result = await Bun.build({
        entrypoints: [entry],
        target: "bun",
        format: "esm",
        tsconfig: join(repository, "apps/server/tsconfig.json"),
        external: OPTIONAL_NEST_EXTENSIONS,
        compile: {
          outfile: binary,
          autoloadDotenv: false,
          autoloadBunfig: false,
          autoloadPackageJson: false,
          autoloadTsconfig: false,
        },
        plugins: [embedding.plugin],
      });
      expect(result.success).toBe(true);
      expect(embedding.used()).toBe(true);
    } else {
      await copyFile(
        process.env.RELAY_SERVER_TEST_BINARY ??
          join(
            repository,
            "apps/server/dist",
            process.platform === "win32" ? "relay-server.exe" : "relay-server",
          ),
        binary,
      );
    }
    await chmod(binary, 0o755);
    await action(directory, binary);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/**
 * Событийный side channel тестового дочернего процесса, без polling файлов или sleep.
 * Socket cancelled остаётся живым до явного release, чтобы проверить lease во время cleanup.
 */
async function openProbe(): Promise<{
  /* Выделенный loopback-порт событий дочернего процесса. */
  port: number;
  /* Подтверждение входа в удерживаемый writer/Runtime request. */
  started: Promise<Socket>;
  /* SIGTERM получен Runtime helper, но тот ещё ждёт разрешение завершить cleanup. */
  cancelled: Promise<Socket>;
  /* Production main обработал EOF parent lease и начал shutdown. */
  draining: Promise<Socket>;
  /* Закрывает принадлежащие probe listener и sockets. */
  close: () => Promise<void>;
}> {
  const started = Promise.withResolvers<Socket>();
  const cancelled = Promise.withResolvers<Socket>();
  const draining = Promise.withResolvers<Socket>();
  const sockets = new Set<Socket>();
  const listener = createServer((socket) => {
    sockets.add(socket);
    let text = "";
    socket.on("error", () => {});
    socket.on("close", () => sockets.delete(socket));
    socket.on("data", (chunk) => {
      text += chunk.toString();
      if (text.includes("started\n")) {
        started.resolve(socket);
      }
      if (text.includes("cancelled\n")) {
        cancelled.resolve(socket);
      }
      if (text.includes("draining\n")) {
        draining.resolve(socket);
      }
    });
  });
  listener.listen(0, "127.0.0.1");
  await once(listener, "listening");
  const address = listener.address();
  if (address === null || typeof address === "string") {
    listener.close();
    throw new Error("Нет порта side channel");
  }
  return {
    port: address.port,
    started: started.promise,
    cancelled: cancelled.promise,
    draining: draining.promise,
    close: async () => {
      for (const socket of sockets) {
        socket.destroy();
      }
      await new Promise<void>((resolve) => listener.close(() => resolve()));
    },
  };
}

/**
 * Компилирует управляемый процесс Git Sync: --version реален, --request удерживается до SIGTERM/release.
 * Реальный Server вызывает его через текущий Runtime и собственный standalone guardian.
 */
async function controlledGitBinary(directory: string): Promise<string> {
  const source = join(directory, "controlled-git.ts");
  const binary = join(
    directory,
    process.platform === "win32" ? "controlled-git.exe" : "controlled-git",
  );
  await writeFile(
    source,
    `
import { createConnection } from "node:net";
import { once } from "node:events";
if (process.argv.includes("--version")) {
  console.log("relay-git-sync 0.0.0");
  process.exit(0);
}
const request = JSON.parse(await Bun.stdin.text());
if (request.version !== 1 || request.action !== "request.get") { process.exit(2); }
const probe = createConnection({ host: "127.0.0.1", port: Number(process.env.RELAY_TEST_PROBE_PORT) });
await once(probe, "connect");
process.on("SIGTERM", () => probe.write("cancelled\\n"));
probe.on("data", (chunk) => { if (chunk.toString().includes("release")) { probe.end(() => process.exit(0)); } });
probe.write("started\\n");
await new Promise<never>(() => {});
`,
  );
  const result = await Bun.build({
    entrypoints: [source],
    target: "bun",
    compile: {
      outfile: binary,
      autoloadDotenv: false,
      autoloadBunfig: false,
      autoloadPackageJson: false,
      autoloadTsconfig: false,
    },
  });
  expect(result.success).toBe(true);
  await chmod(binary, 0o755);
  return binary;
}

describe("Shutdown самостоятельного Nest Server", () => {
  test.each([{ forbidden: false }, { forbidden: true }])(
    "неполный POST с уже отправленным403=$forbidden завершается без клиентского EOF и освобождает lease",
    async ({ forbidden }) => {
      await withShutdownBinary(async (directory, binary) => {
        const runtime = { cwd: join(directory, "project"), home: join(directory, "home") };
        const location = initializeProject({ ...runtime, name: "Неполный ввод" });
        const launch = createServerLaunch(runtime, {
          version: "0.0.0",
          mode: "foreground",
          port: 0,
        });
        const child = await startChild(
          binary,
          runtime.cwd,
          ["run", "--launch", launch.path, "--parent-lease"],
          {
            ...process.env,
            HOME: directory,
            RELAY_HOME: runtime.home,
          },
        );
        let socket: Socket | undefined;
        try {
          const url = new URL(child.ready.url);
          socket = createConnection({ host: "127.0.0.1", port: Number(url.port) });
          socket.on("error", () => {});
          let text = "";
          const accepted = Promise.withResolvers<void>();
          socket.on("data", (chunk) => {
            text += chunk.toString();
            if (
              forbidden ? text.includes('"code":"ORIGIN_FORBIDDEN"') : text.includes("100 Continue")
            ) {
              accepted.resolve();
            }
          });
          await deadline(once(socket, "connect"), 2000);
          socket.write(
            `POST /api/v2/projects/${location.projectId}/commands HTTP/1.1\r\nHost: ${url.host}\r\nContent-Type: application/json\r\nContent-Length: 200\r\nExpect: 100-continue\r\n${forbidden ? "Origin: https://foreign.example\r\n" : ""}\r\n{`,
          );
          await deadline(accepted.promise, 2000);
          expectBusy(launch);
          child.process.stdin.end();

          expect(await deadline(child.process.exited, 3000)).toBe(0);
          expect(await child.stderr).toBe("");
          acquireServerInstance(launch).close();
          const { database } = openProject(runtime);
          try {
            expect(new KnowledgeService(database).list("document")).toEqual([]);
          } finally {
            database.close();
          }
        } finally {
          socket?.destroy();
          await stopChild(child);
        }
      });
    },
    20000,
  );

  // Bun 1.4.3 использует libuv TerminateProcess для Windows kill(SIGTERM): JS handler не вызывается.
  // Fixed-input helper уже прочитал stdin до EOF; проверка доставки сигнала относится только к POSIX.
  test.skipIf(process.platform === "win32")(
    "настоящий Runtime request получает SIGTERM только после grace, lease ждёт guardian cleanup",
    async () => {
      await withShutdownBinary(async (directory, binary) => {
        const runtime = { cwd: join(directory, "project"), home: join(directory, "home") };
        const location = initializeProject({ ...runtime, name: "Runtime drain" });
        const launch = createServerLaunch(runtime, {
          version: "0.0.0",
          mode: "foreground",
          port: 0,
        });
        const helper = await controlledGitBinary(directory);
        const probe = await openProbe();
        let child: ServerChild | undefined;
        let request: Promise<unknown> | undefined;
        try {
          child = await startChild(binary, runtime.cwd, ["run", "--launch", launch.path], {
            ...process.env,
            HOME: directory,
            RELAY_HOME: runtime.home,
            RELAY_GIT_SYNC_BIN: helper,
            RELAY_TEST_PROBE_PORT: String(probe.port),
          });
          request = fetch(
            new URL(
              `/api/v2/projects/${location.projectId}/git-sync/requests/held`,
              child.ready.url,
            ),
          ).then(
            async (response) => ({ status: response.status, body: await response.json() }),
            (error: unknown) => ({ error }),
          );
          await deadline(probe.started, 5000);
          const startedAt = performance.now();
          child.process.kill("SIGTERM");
          const cancelled = await deadline(probe.cancelled, REQUEST_GRACE_MS + 3000);

          expect(performance.now() - startedAt).toBeGreaterThanOrEqual(REQUEST_GRACE_MS - 100);
          expect(child.process.exitCode).toBeNull();
          expectBusy(launch);
          cancelled.write("release\n");
          expect(await deadline(request, 5000)).toMatchObject({
            status: 500,
            body: {
              ok: false,
              error: {
                code: "GIT_SYNC_CANCELLED",
                details: { requestId: "held", state: "unknown" },
              },
            },
          });
          expect(await deadline(child.process.exited, 5000)).toBe(0);
          expect(await Bun.file(join(dirname(launch.path), "endpoint.json")).exists()).toBe(false);
          acquireServerInstance(launch).close();
          expect(await child.stderr).toBe("");
        } finally {
          await probe.close();
          if (child !== undefined) {
            await stopChild(child);
          }
          await request;
        }
      });
    },
    25000,
  );

  test("production main выходит124 при незавершимом writer, lease остаётся до смерти процесса", async () => {
    await withShutdownBinary(async (directory, binary) => {
      const runtime = { cwd: join(directory, "project"), home: join(directory, "home") };
      const location = initializeProject({ ...runtime, name: "Deadline writer" });
      const launch = createServerLaunch(runtime, { version: "0.0.0", mode: "foreground", port: 0 });
      const probe = await openProbe();
      let child: ServerChild | undefined;
      let request: Promise<unknown> | undefined;
      try {
        child = await startChild(
          binary,
          runtime.cwd,
          ["run", "--launch", launch.path, "--parent-lease"],
          {
            ...process.env,
            HOME: directory,
            RELAY_HOME: runtime.home,
            RELAY_TEST_PROBE_PORT: String(probe.port),
          },
        );
        request = fetch(
          new URL(`/api/v2/projects/${location.projectId}/commands`, child.ready.url),
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              op: "document.create",
              input: { name: "Не завершён", body: "Не записан" },
              actor: "Web",
              operationKey: "deadline",
            }),
          },
        ).then(
          () => "response",
          () => "disconnected",
        );
        await deadline(probe.started, 5000);
        child.process.stdin.end();
        await deadline(probe.draining, 2000);
        const response = await fetch(new URL("/api/v2/context", child.ready.url));
        expect(response.status).toBe(503);
        expect(await response.json()).toMatchObject({ error: { code: "SERVER_CLOSING" } });
        expectBusy(launch);

        expect(await deadline(child.process.exited, SHUTDOWN_DEADLINE_MS + 3000)).toBe(124);
        expect(JSON.parse(await child.stderr)).toMatchObject({
          error: { code: "SERVER_SHUTDOWN_TIMEOUT", details: { timeoutMs: SHUTDOWN_DEADLINE_MS } },
        });
        expect(await request).toBe("disconnected");
        expect(await Bun.file(join(dirname(launch.path), "endpoint.json")).exists()).toBe(true);
        acquireServerInstance(launch).close();
        const { database } = openProject(runtime);
        try {
          expect(new KnowledgeService(database).list("document")).toEqual([]);
          expect(() => new BatchService(database).getResult("deadline")).toThrow(
            expect.objectContaining({ code: "NOT_FOUND" }),
          );
        } finally {
          database.close();
        }
      } finally {
        await probe.close();
        if (child !== undefined) {
          await stopChild(child);
        }
        await request;
      }
    }, "blocked-writer");
  }, 25000);
});
