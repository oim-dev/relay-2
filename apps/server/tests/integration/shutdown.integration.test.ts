import { describe, expect, spyOn, test } from "bun:test";
import { once } from "node:events";
import { createConnection, type Socket } from "node:net";
import {
  acquireServerInstance,
  createServerLaunch,
  type ServerLaunch,
} from "@relay/project-runtime";
import { BatchService, KnowledgeService } from "@relay/core";
import { createRelayServer } from "../../src/server";
import { REQUEST_GRACE_MS, SHUTDOWN_DEADLINE_MS, shutdown } from "../../src/process/shutdown";
import type { ShutdownClock } from "../../src/process/shutdown.types";
import { withServer } from "./fixture";

/**
 * Ограничивает ожидание события, не используется как sleep или performance assertion.
 */
async function bounded<T>(promise: Promise<T>, milliseconds = 2000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("Shutdown не завершился после барьера")),
          milliseconds,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Создаёт собственный raw socket. Ошибка после server-side destroy ожидаема и не теряется как unhandled.
 */
async function connect(port: number): Promise<Socket> {
  const socket = createConnection({ host: "127.0.0.1", port });
  socket.on("error", () => {});
  try {
    await bounded(once(socket, "connect"));
    return socket;
  } catch (error) {
    socket.destroy();
    throw error;
  }
}

/**
 * Подтверждает реальное занятие Runtime lease; неожиданно полученный lease сразу освобождается.
 */
function expectBusy(launch: ServerLaunch): void {
  expect(() => {
    const unexpected = acquireServerInstance(launch);
    unexpected.close();
  }).toThrow(expect.objectContaining({ code: "LOCAL_LOCK_BUSY" }));
}

/**
 * Детерминированные часы только одного shutdown; глобальные Bun/Node timers не меняются.
 */
class ManualClock implements ShutdownClock {
  /* Текущая позиция монотонного времени проверки, миллисекунды. */
  private now = 0;
  /* Активные callbacks по запланированному абсолютному времени. */
  private readonly timers = new Map<() => void, number>();

  /**
   * Регистрирует callback и возвращает отмену именно этого таймера.
   */
  schedule(delayMs: number, callback: () => void): () => void {
    this.timers.set(callback, this.now + delayMs);
    return () => {
      this.timers.delete(callback);
    };
  }

  /**
   * Исполняет наступившие события в порядке времени без реального ожидания.
   */
  advance(milliseconds: number): void {
    const target = this.now + milliseconds;
    for (;;) {
      const next = [...this.timers].sort((left, right) => left[1] - right[1])[0];
      if (next === undefined || next[1] > target) {
        break;
      }
      this.now = next[1];
      this.timers.delete(next[0]);
      next[0]();
    }
    this.now = target;
  }

  /**
   * Число принадлежащих сценарию ещё не освобождённых таймеров.
   */
  get size(): number {
    return this.timers.size;
  }
}

describe("Завершение HTTP-ввода и принятых writers", () => {
  test.each([
    { factory: "start", forbidden: false },
    { factory: "start", forbidden: true },
    { factory: "create", forbidden: false },
    { factory: "create", forbidden: true },
  ])(
    "$factory close завершает неполный POST, уже отправленный 403=$forbidden не удерживает socket",
    async ({ factory, forbidden }) => {
      await withServer(async ({ server, runtime, location, database }) => {
        const application =
          factory === "start"
            ? server
            : await createRelayServer({ runtime, actor: "Web", version: "test" });
        let socket: Socket | undefined;
        let closing: Promise<void> | undefined;
        try {
          if (factory === "create") {
            await application.app.listen(0, "127.0.0.1");
          }
          const url = new URL(await application.app.getUrl());
          const accepted = once(application.app.getHttpServer(), "request");
          socket = await connect(Number(url.port));
          let text = "";
          const rejected = Promise.withResolvers<void>();
          socket.on("data", (chunk) => {
            text += chunk.toString();
            if (text.includes('"code":"ORIGIN_FORBIDDEN"')) {
              rejected.resolve();
            }
          });
          socket.write(
            `POST /api/v2/projects/${location.projectId}/commands HTTP/1.1\r\nHost: ${url.host}\r\nContent-Type: application/json\r\nContent-Length: 200\r\n${forbidden ? "Origin: https://foreign.example\r\n" : ""}\r\n{`,
          );
          await bounded(accepted);
          if (forbidden) {
            await bounded(rejected.promise);
            expect(text).toStartWith("HTTP/1.1 403");
          }

          closing = application.close();
          await bounded(closing);

          expect(await database((db) => new KnowledgeService(db).list("document"))).toEqual([]);
        } finally {
          socket?.destroy();
          await (closing ?? application.close());
        }
      });
    },
  );

  test.each(["idle", "partial-headers", "keep-alive"] as const)(
    "%s соединение не задерживает завершение",
    async (mode) => {
      await withServer(async ({ server }) => {
        const accepted = once(server.app.getHttpServer(), "connection");
        const socket = await connect(server.port);
        let closing: Promise<void> | undefined;
        try {
          await bounded(accepted);
          if (mode === "partial-headers") {
            socket.write("POST /api/v2/context HTTP/1.1\r\n");
          } else if (mode === "keep-alive") {
            const response = once(socket, "data");
            socket.write(
              `GET /api/v2/context HTTP/1.1\r\nHost: 127.0.0.1:${server.port}\r\nConnection: keep-alive\r\n\r\n`,
            );
            const [chunk] = await bounded(response);
            expect(String(chunk)).toStartWith("HTTP/1.1 200");
          }
          closing = server.close();
          await bounded(closing);
        } finally {
          socket.destroy();
          await (closing ?? server.close());
        }
      });
    },
  );

  test("disconnect клиента не отменяет принятый Core writer: close ждёт commit и receipt", async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const original = BatchService.prototype.execute;
    await withServer(async ({ server, location, database }) => {
      const writer = spyOn(BatchService.prototype, "execute").mockImplementation(async function (
        this: BatchService,
        input,
        options,
      ) {
        entered.resolve();
        await release.promise;
        return original.call(this, input, options);
      });
      const abort = new AbortController();
      let closing: Promise<void> | undefined;
      let late: Socket | undefined;
      try {
        const outcome = fetch(`${server.url}api/v2/projects/${location.projectId}/commands`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            op: "document.create",
            input: { name: "Сохранится", body: "После disconnect" },
            actor: "Web",
            operationKey: "disconnected-write",
          }),
          signal: abort.signal,
        }).then(
          () => "response",
          () => "disconnected",
        );
        await bounded(entered.promise);
        abort.abort();
        expect(await bounded(outcome)).toBe("disconnected");
        let closed = false;
        closing = server.close().then(() => {
          closed = true;
        });
        const rejected = await server.app.inject({
          method: "GET",
          url: "/api/v2/context",
          headers: { host: new URL(server.url).host },
        });
        expect(rejected.statusCode).toBe(503);
        expect(closed).toBe(false);
        late = await connect(server.port);
        const denied = once(late, "data");
        late.write(
          `POST /api/v2/projects/${location.projectId}/commands HTTP/1.1\r\nHost: 127.0.0.1:${server.port}\r\nContent-Type: application/json\r\nContent-Length: 200\r\n\r\n{`,
        );
        const [response] = await bounded(denied);
        expect(String(response)).toContain('"code":"SERVER_CLOSING"');

        release.resolve();
        await bounded(closing);

        expect(await database((db) => new KnowledgeService(db).list("document"))).toMatchObject([
          { data: { body: "После disconnect" } },
        ]);
        expect(
          await database((db) => new BatchService(db).getResult("disconnected-write")),
        ).toMatchObject({
          status: "committed",
          replayed: true,
          entities: [{ data: { body: "После disconnect" } }],
        });
      } finally {
        abort.abort();
        release.resolve();
        late?.destroy();
        await closing;
        writer.mockRestore();
      }
    });
  });
});

describe("Grace, отмена Runtime и lifetime lease", () => {
  test("grace не отменяет Runtime раньше срока; lease освобождается только после cleanup", async () => {
    await withServer(async ({ runtime }) => {
      const launch = createServerLaunch(runtime, { version: "test", mode: "foreground", port: 0 });
      const registration = acquireServerInstance(launch);
      const clock = new ManualClock();
      const requests = new AbortController();
      const released = Promise.withResolvers<void>();
      const events: string[] = [];
      requests.signal.addEventListener("abort", () => events.push("abort"), { once: true });
      let stopping: Promise<void> | undefined;
      try {
        stopping = shutdown(
          {
            close: async () => {
              events.push("close");
              await released.promise;
              events.push("cleanup");
            },
          },
          {
            draining: () => {
              events.push("draining");
              registration.draining();
            },
            close: () => {
              events.push("release-lease");
              registration.close();
            },
          },
          requests,
          clock,
        );
        expect(events).toEqual(["draining", "close"]);
        clock.advance(REQUEST_GRACE_MS - 1);
        expect(requests.signal.aborted).toBe(false);
        expectBusy(launch);

        clock.advance(1);
        expect(requests.signal.reason).toBe("SIGTERM");
        expect(events).toEqual(["draining", "close", "abort"]);
        expectBusy(launch);
        released.resolve();
        await stopping;

        expect(events).toEqual(["draining", "close", "abort", "cleanup", "release-lease"]);
        expect(clock.size).toBe(0);
        acquireServerInstance(launch).close();
      } finally {
        released.resolve();
        await stopping;
        registration.close();
      }
    });
  });

  test("быстрое завершение отменяет оба таймера без лишнего abort после освобождения lease", async () => {
    const clock = new ManualClock();
    const requests = new AbortController();
    const events: string[] = [];
    await shutdown(
      {
        close: async () => {
          events.push("cleanup");
        },
      },
      {
        draining: () => {
          events.push("draining");
        },
        close: () => {
          events.push("release-lease");
        },
      },
      requests,
      clock,
    );
    clock.advance(SHUTDOWN_DEADLINE_MS);
    expect(events).toEqual(["draining", "cleanup", "release-lease"]);
    expect(requests.signal.aborted).toBe(false);
    expect(clock.size).toBe(0);
  });

  test("deadline даёт 124 после Runtime abort, но незавершённая очистка сохраняет реальный lease", async () => {
    await withServer(async ({ runtime }) => {
      const launch = createServerLaunch(runtime, { version: "test", mode: "foreground", port: 0 });
      const registration = acquireServerInstance(launch);
      const clock = new ManualClock();
      const requests = new AbortController();
      const cleanup = Promise.withResolvers<void>();
      let releases = 0;
      try {
        const stopping = shutdown(
          { close: () => cleanup.promise },
          {
            draining: registration.draining,
            close: () => {
              releases += 1;
              registration.close();
            },
          },
          requests,
          clock,
        );
        const refused = stopping.then(
          () => null,
          (error: unknown) => error,
        );
        clock.advance(REQUEST_GRACE_MS);
        expect(requests.signal.aborted).toBe(true);
        expectBusy(launch);
        clock.advance(SHUTDOWN_DEADLINE_MS - REQUEST_GRACE_MS);
        expect(await refused).toMatchObject({
          code: "SERVER_SHUTDOWN_TIMEOUT",
          exitCode: 124,
          details: { timeoutMs: SHUTDOWN_DEADLINE_MS },
        });

        expect(releases).toBe(0);
        expectBusy(launch);
        expect(clock.size).toBe(0);
        cleanup.resolve();
        await Promise.resolve();
        expect(releases).toBe(0);
      } finally {
        cleanup.resolve();
        registration.close();
      }
    });
  });
});
