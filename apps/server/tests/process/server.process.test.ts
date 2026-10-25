import { describe, expect, test } from "bun:test";
import type { Subprocess } from "bun";
import { mkdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createServerLaunch, initializeProject, listServerInstances } from "@relay/project-runtime";
import { createRelayClient } from "@relay/rest-sdk";
import { collectWebFiles } from "../../src/modules/assets/catalog";
import { deadline, startChild, stopChild, withBinary } from "./process-fixture";

// 15 с на readiness + до 10 с HTTP + 15 с cleanup; runner не прерывает принадлежащую тесту уборку.
const PROCESS_TEST_TIMEOUT_MS = 45_000;

/**
 * Читает принадлежащий child pipe до EOF и снимает reader lock даже при отказе потока.
 */
async function readChildPipe(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = "";
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) {
        return text + decoder.decode();
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }
}

/**
 * Принимает владение коротким child без потомков и читает оба потока параллельно до EOF.
 * При deadline/ошибке обязательно завершает child до возврата caller; stdout/stderr других readers не имеют.
 */
async function collectShortChild(
  child: Subprocess<"ignore", "pipe", "pipe">,
  timeoutMs = 5000,
): Promise<readonly [number, string, string]> {
  const stdout = readChildPipe(child.stdout);
  const stderr = readChildPipe(child.stderr);
  try {
    return await deadline(Promise.all([child.exited, stdout, stderr]), timeoutMs);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
    }
    await Promise.allSettled([child.exited, stdout, stderr]);
  }
}

describe("Самостоятельный Nest/Fastify binary", () => {
  test("deadline короткого child завершает его и освобождает оба pipe до отказа caller", async () => {
    const started = Promise.withResolvers<void>();
    const child = Bun.spawn(
      [
        process.execPath,
        "-e",
        'console.log("stdout"); console.error("stderr"); process.send("started"); setInterval(() => {}, 1000);',
      ],
      {
        env: {},
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        /**
         * Подтверждает запуск child отдельным каналом; stdout остаётся у проверяемого helper.
         */
        ipc(message) {
          if (message === "started") {
            started.resolve();
          }
        },
      },
    );
    let collected = false;
    try {
      await deadline(started.promise, 2000);
      expect(child.exitCode).toBeNull();

      collected = true;
      await expect(collectShortChild(child, 20)).rejects.toThrow("Превышен deadline процесса");

      expect(child.signalCode).toBe("SIGKILL");
      expect(() => process.kill(child.pid, 0)).toThrow(expect.objectContaining({ code: "ESRCH" }));
      expect(child.stdout.locked).toBe(false);
      expect(child.stderr.locked).toBe(false);
    } finally {
      // Страховка runner при регрессии самого cleanup; assertions выше проверяют исход до этой уборки.
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
      await child.exited;
      if (!collected) {
        await Promise.allSettled([readChildPipe(child.stdout), readChildPipe(child.stderr)]);
      }
    }
  });

  test("help/version автономны в пустом cwd/home и не требуют внешних Node пакетов", async () => {
    await withBinary(async (directory, binary) => {
      const cwd = join(directory, "empty");
      await mkdir(cwd);
      for (const flag of ["--version", "--help"]) {
        const child = Bun.spawn([binary, flag], {
          cwd,
          env: {
            PATH: "/nonexistent",
            HOME: join(directory, "missing-home"),
            RELAY_HOME: join(directory, "missing-relay"),
          },
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
        });
        const [code, out, error] = await collectShortChild(child);

        expect(code).toBe(0);
        expect(error).toBe("");
        expect(out).toContain(flag === "--version" ? "relay-server 0.0.0" : "--allow-origin");
      }
      expect(await Bun.file(join(directory, "missing-relay", "servers")).exists()).toBe(false);
    });
  }, 15_000);

  test(
    "перенесённый binary обслуживает все готовые Vite bytes, HEAD/cache и Core запись под Runtime регистрацией",
    async () => {
      await withBinary(async (directory, binary) => {
        const runtime = { cwd: join(directory, "project"), home: join(directory, "home") };
        const location = initializeProject({ ...runtime, name: "Compiled", slug: "compiled" });
        const env = { HOME: directory, RELAY_HOME: runtime.home, PATH: "/nonexistent" };
        const child = await startChild(
          binary,
          runtime.cwd,
          ["--port", "0", "--actor", "Compiled author"],
          env,
        );
        try {
          const signal = AbortSignal.timeout(10_000);
          const client = createRelayClient({
            baseUrl: child.ready.url,
            fetch: Object.assign(
              (
                input: Parameters<typeof fetch>[0],
                init?: Parameters<typeof fetch>[1],
              ): Promise<Response> => fetch(input, { ...init, signal }),
              { preconnect: fetch.preconnect },
            ),
          });
          expect((await client.context()).data).toMatchObject({
            actor: "Compiled author",
            projects: [{ id: location.projectId }],
          });
          const written = await client.command(location.projectId, {
            op: "document.create",
            input: { name: "Binary", body: "Точный \ud800 текст" },
            actor: "Человек",
            operationKey: "compiled",
          });
          expect((await client.receipt(location.projectId, "compiled")).data).toEqual({
            ...written.data,
            replayed: true,
          });
          const assets = collectWebFiles(resolve(import.meta.dir, "../../../web/dist"));
          expect(assets.length).toBeGreaterThan(1);
          for (const asset of assets) {
            const response = await fetch(new URL(asset.url, child.ready.url), { signal });
            expect(response.status).toBe(200);
            expect(new Uint8Array(await response.arrayBuffer())).toEqual(asset.bytes);
            expect(response.headers.get("etag")).toBe(asset.etag);
            expect(response.headers.get("content-type")).toBe(asset.contentType);
          }
          const head = await fetch(new URL("/index.html", child.ready.url), {
            method: "HEAD",
            signal,
          });
          expect(await head.text()).toBe("");
          expect(head.headers.get("cache-control")).toBe("no-cache");
          const unchanged = await fetch(new URL("/index.html", child.ready.url), {
            signal,
            headers: { "If-None-Match": head.headers.get("etag") ?? "" },
          });
          expect(unchanged.status).toBe(304);
          expect(await unchanged.text()).toBe("");
          const spa = await fetch(
            new URL(`/projects/${location.projectId}/documents`, child.ready.url),
            { headers: { Accept: "text/html" }, signal },
          );
          expect(await spa.text()).toBe(
            await readFile(resolve(import.meta.dir, "../../../web/dist/index.html"), "utf8"),
          );
          const missing = await fetch(new URL("/assets/missing.js", child.ready.url), { signal });
          expect(missing.status).toBe(404);
          await missing.arrayBuffer();
          const listing = await listServerInstances(runtime, {
            cwd: runtime.cwd,
            env,
            version: "0.0.0",
            executablePath: binary,
            userHome: directory,
          });
          expect(listing.running).toBe(1);
          expect(listing.items).toMatchObject([
            {
              instanceId: child.ready.instanceId,
              state: "ready",
              projects: [{ id: location.projectId, available: true }],
            },
          ]);
        } finally {
          await stopChild(child);
        }
        expect(child.process.exitCode).toBe(0);
        expect(await child.stderr).toBe("");
      });
    },
    PROCESS_TEST_TIMEOUT_MS,
  );

  test(
    "run --launch соблюдает stdin lease и освобождает Runtime владение после SSE",
    async () => {
      await withBinary(async (directory, binary) => {
        const runtime = { cwd: join(directory, "project"), home: join(directory, "home") };
        const location = initializeProject({ ...runtime, name: "Lease" });
        const launch = createServerLaunch(runtime, {
          version: "0.0.0",
          mode: "foreground",
          port: 0,
          actor: "Lease",
        });
        const env = { HOME: directory, RELAY_HOME: runtime.home, PATH: "/nonexistent" };
        const child = await startChild(
          binary,
          runtime.cwd,
          ["run", "--launch", launch.path, "--parent-lease"],
          env,
        );
        try {
          const response = await fetch(
            new URL(`/api/v2/projects/${location.projectId}/events`, child.ready.url),
            { signal: AbortSignal.timeout(10000) },
          );
          const reader = response.body?.getReader();
          if (reader === undefined) {
            throw new Error("Нет SSE body");
          }
          try {
            expect(new TextDecoder().decode((await reader.read()).value)).toContain(
              "event: connected",
            );
            child.process.stdin.end();
            expect(await deadline(child.process.exited)).toBe(0);
            expect((await reader.read()).done).toBe(true);
          } finally {
            try {
              await reader.cancel();
            } finally {
              reader.releaseLock();
            }
          }
          const listing = await listServerInstances(
            runtime,
            {
              cwd: runtime.cwd,
              env,
              version: "0.0.0",
              executablePath: binary,
              userHome: directory,
            },
            launch.instanceId,
          );
          expect(listing.running).toBe(0);
          expect(listing.items).toMatchObject([
            { instanceId: launch.instanceId, state: "stopped" },
          ]);
        } finally {
          await stopChild(child);
        }
      });
    },
    PROCESS_TEST_TIMEOUT_MS,
  );

  test("несовместимый launch завершается с SERVER_VERSION_MISMATCH без ready", async () => {
    await withBinary(async (directory, binary) => {
      const runtime = { cwd: join(directory, "project"), home: join(directory, "home") };
      initializeProject({ ...runtime, name: "Несовместимый launch" });
      const incompatible = createServerLaunch(runtime, {
        version: "other",
        mode: "foreground",
        port: 0,
      });
      const refused = Bun.spawn([binary, "run", "--launch", incompatible.path], {
        cwd: runtime.cwd,
        env: { HOME: directory, RELAY_HOME: runtime.home, PATH: "/nonexistent" },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      });
      const [code, out, diagnostic] = await collectShortChild(refused);

      expect(code).toBe(4);
      expect(out).toBe("");
      expect(JSON.parse(diagnostic)).toMatchObject({ error: { code: "SERVER_VERSION_MISMATCH" } });
    });
  }, 10_000);
});
