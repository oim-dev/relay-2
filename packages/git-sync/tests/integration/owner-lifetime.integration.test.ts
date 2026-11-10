import { describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import * as runtime from "@relay/project-runtime";
import { ProjectDatabase } from "@relay/storage";
import { executeGitSyncRequest } from "../../src/index";
import * as projectConnection from "../../src/app/project-connection";
import * as control from "../../src/local/control";
import { readOperation } from "../../src/local/operations";
import { configuration, stateDirectory } from "../../src/local/state";
import { withExchangeDirectory } from "./helpers/exchange-fixture";
import { containsFailure } from "./helpers/source-runtime-fixture";

describe("Владение до принятия библиотечного обращения", () => {
  test("отказ публикации endpoint ждёт stop с удержанным mutex и сохраняет обе причины", async () => {
    await withExchangeDirectory(async (root) => {
      const endpointPath = join(root, "worker.json");
      const publicationFailure = Object.assign(new Error("Endpoint не опубликован"), {
        code: "EACCES",
      });
      const stopFailure = new Error("Остановка listener не подтверждена");
      const enteredStop = Promise.withResolvers<void>();
      const releaseStop = Promise.withResolvers<void>();
      const actualServe = Bun.serve;
      const actualReplace = runtime.replaceLocalFile;
      let nativeStop: ((force?: boolean) => Promise<void>) | undefined;
      let stopping: Promise<void> | undefined;
      let restoreStop: (() => void) | undefined;
      let returned = false;
      /**
       * Создаёт настоящий listener с исходными параметрами owner и удерживает лишь подтверждение его stop.
       * Тест снимает подмену и дожидается всех stop Promise до удаления fixture, включая ранний отказ.
       */
      function listenerWithStopBarrier<WebSocketData = undefined, R extends string = never>(
        options: Bun.Serve.Options<WebSocketData, R>,
      ): Bun.Server<WebSocketData> {
        const server = actualServe(options);
        const actualStop = server.stop.bind(server);
        nativeStop = actualStop;
        /**
         * Реально останавливает listener до барьера, затем возвращает управляемый вторичный отказ.
         */
        async function stopAfterBarrier(force?: boolean): Promise<void> {
          await actualStop(force);
          enteredStop.resolve();
          await releaseStop.promise;
          throw stopFailure;
        }
        const stop = spyOn(server, "stop").mockImplementation((force) => {
          stopping = stopAfterBarrier(force);
          // Старый fire-and-forget путь тоже должен завершить подмену без unhandled rejection теста.
          void stopping.catch(() => {});
          return stopping;
        });
        restoreStop = stop.mockRestore.bind(stop);
        return server;
      }
      const serve = spyOn(Bun, "serve").mockImplementation(listenerWithStopBarrier);
      const replace = spyOn(runtime, "replaceLocalFile").mockImplementation((source, target) => {
        if (target === endpointPath) {
          throw publicationFailure;
        }
        actualReplace(source, target);
      });
      const completion = Promise.allSettled([
        control
          .ownControl(endpointPath, "request", join(root, "project.sqlite"), async () => null)
          .finally(() => {
            returned = true;
          }),
      ]);
      try {
        await Promise.race([
          enteredStop.promise,
          completion.then(() => {
            throw new Error("Owner вернулся до подтверждения stop listener");
          }),
        ]);

        expect(returned).toBe(false);
        expect(() => {
          const lock = control.acquireControlLock(endpointPath);
          lock.release();
        }).toThrow(expect.objectContaining({ code: "GIT_SYNC_WORKER_BUSY" }));
        releaseStop.resolve();
        const [outcome] = await completion;

        expect(outcome).toMatchObject({
          status: "rejected",
          reason: {
            errors: [
              publicationFailure,
              {
                code: "GIT_CLEANUP_FAILED",
                exitCode: 1,
                details: { operation: "control-owner-cleanup", path: endpointPath },
              },
            ],
          },
        });
        if (outcome?.status !== "rejected") {
          throw new Error("Ожидался отказ публикации endpoint");
        }
        expect(containsFailure(outcome.reason, publicationFailure)).toBe(true);
        expect(containsFailure(outcome.reason, stopFailure)).toBe(true);
        expect(existsSync(endpointPath)).toBe(false);
        const lock = control.acquireControlLock(endpointPath);
        lock.release();
      } finally {
        releaseStop.resolve();
        const [outcome] = await completion;
        if (outcome?.status === "fulfilled") {
          await outcome.value.close().catch(() => {});
        }
        await stopping?.catch(() => {});
        restoreStop?.();
        serve.mockRestore();
        replace.mockRestore();
        await nativeStop?.(true);
      }
    });
  });

  test("отмена после получения owner не принимает новый operationId и освобождает listener и mutex", async () => {
    await withExchangeDirectory(async (root) => {
      const home = join(root, "home");
      mkdirSync(home);
      const options = { cwd: root, home: join(root, "runtime-home") };
      const location = runtime.initializeProject({ ...options, name: "Cancelled acceptance" });
      const directory = stateDirectory(location.databasePath);
      const endpointPath = join(directory, "worker.json");
      const config = configuration(location, options, join(root, "remote.git"), "relay-data");
      const initial = ProjectDatabase.open(location.databasePath);
      let outbox: ReturnType<ProjectDatabase["getReplicationOutbox"]>;
      try {
        outbox = initial.getReplicationOutbox();
      } finally {
        initial.close();
      }
      const controller = new AbortController();
      const actualOwn = control.ownControl;
      let owner: Awaited<ReturnType<typeof control.ownControl>> | undefined;
      /**
       * Отменяет на точной границе после настоящего bind/publication, до continuation вызывающего one-shot.
       * Owner остаётся настоящим; production обязан закрыть его до возврата отмены, тест страхует cleanup.
       */
      async function cancelAfterOwner(
        ...args: Parameters<typeof control.ownControl>
      ): ReturnType<typeof control.ownControl> {
        owner = await actualOwn(...args);
        controller.abort("SIGTERM");
        return owner;
      }
      const own = spyOn(control, "ownControl").mockImplementation(cancelAfterOwner);
      const discovery = spyOn(projectConnection, "discoverProjectConnection").mockResolvedValue(
        config,
      );
      const id = "cancelled-before-acceptance";
      const completion = Promise.allSettled([
        executeGitSyncRequest(
          { version: 1, action: "now", options, input: { operationId: id } },
          {
            env: { ...process.env, HOME: home, USERPROFILE: home, RELAY_HOME: options.home },
            signal: controller.signal,
          },
        ),
      ]);
      try {
        const [outcome] = await completion;

        expect(controller.signal.aborted).toBe(true);
        expect(outcome).toMatchObject({
          status: "rejected",
          reason: {
            code: "GIT_SYNC_CANCELLED",
            exitCode: 143,
            details: { requestId: id, operationId: id, state: "unknown" },
          },
        });
        expect(existsSync(join(directory, "control-outcomes.json"))).toBe(false);
        expect(readOperation(directory, id)).toEqual({
          version: 1,
          requestId: id,
          instance: null,
          state: "unknown",
        });
        expect(existsSync(join(directory, "progress.json"))).toBe(false);
        expect(existsSync(endpointPath)).toBe(false);
        if (owner === undefined) {
          throw new Error("Отмена должна произойти после получения owner");
        }
        expect(await control.responsive(owner.endpoint)).toBe(false);
        const lock = control.acquireControlLock(endpointPath);
        lock.release();
        const reopened = ProjectDatabase.open(location.databasePath);
        try {
          expect(reopened.getReplicationOutbox()).toEqual(outbox);
        } finally {
          reopened.close();
        }
      } finally {
        controller.abort();
        await completion;
        try {
          await owner?.close();
        } finally {
          discovery.mockRestore();
          own.mockRestore();
        }
      }
    });
  });
});
