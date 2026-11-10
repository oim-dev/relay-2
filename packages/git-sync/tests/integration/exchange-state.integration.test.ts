import { describe, expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { RelayError } from "@relay/contracts";
import {
  currentNativePlatform,
  initializeProject,
  resolveProjectRestoration,
  resolveVacantRestorationTarget,
} from "@relay/project-runtime";
import { ProjectDatabase } from "@relay/storage";
import { ownControl } from "../../src/local/control";
import { ControlOperations, readOperation } from "../../src/local/operations";
import { getOperation } from "../../src/local/operation-client";
import { configuration, stateDirectory } from "../../src/local/state";
import { oneShot } from "../../src/app/one-shot";
import { DataRepository } from "../../src/transport/repository";
import { withExchangeDirectory } from "./helpers/exchange-fixture";
import { withGitRepository } from "./helpers/git-repository-fixture";
import { createLocalProject } from "./helpers/local-project";
import { executeGitSyncRequest } from "../../src/index";
import * as projectConnection from "../../src/app/project-connection";
import { SyncEngine } from "../../src/sync/engine";

describe("Контекст и lifetime одноразового обмена", () => {
  test.skipIf(currentNativePlatform() === "win32")(
    "preflight сохраняет выбранный config alias, а transport context возвращает физический путь",
    async () => {
      await withExchangeDirectory(async (root) => {
        const target = join(root, "target");
        mkdirSync(target);
        const configPath = join(target, "relay.config.json");
        writeFileSync(
          configPath,
          JSON.stringify({
            version: 1,
            projectId: "selected-project",
            databasePath: ".relay/project.sqlite",
          }),
        );
        const alias = join(root, "alias.json");
        symlinkSync(configPath, alias);
        const options = { cwd: root, config: alias };

        const context = resolveProjectRestoration(options);
        const location = resolveVacantRestorationTarget(options, "selected-project");

        expect(context.configPath).toBe(configPath);
        expect(location.configPath).toBe(alias);
        expect(context.databasePath).toBe(join(target, ".relay", "project.sqlite"));
        expect(location.databasePath).toBe(join(target, ".relay", "project.sqlite"));
        expect(existsSync(join(target, ".relay"))).toBe(false);
      });
    },
  );

  test("restore выбирает физический проект workspace без открытия отсутствующей SQLite", async () => {
    await withExchangeDirectory(async (root) => {
      const target = join(root, "target");
      mkdirSync(target);
      writeFileSync(
        join(target, "relay.config.json"),
        JSON.stringify({
          version: 1,
          projectId: "selected-project",
          databasePath: ".relay/project.sqlite",
        }),
      );
      writeFileSync(
        join(root, "relay.workspace.json"),
        JSON.stringify({ version: 1, projects: [{ name: "chosen", path: "./target" }] }),
      );

      const selected = resolveProjectRestoration({ cwd: root, project: "chosen" });

      expect(selected).toEqual({
        projectId: "selected-project",
        configPath: join(target, "relay.config.json"),
        databasePath: join(target, ".relay", "project.sqlite"),
      });
      expect(existsSync(join(target, ".relay"))).toBe(false);
      expect(() => resolveProjectRestoration({ cwd: root, project: "unknown" })).toThrow(
        expect.objectContaining({ code: "PROJECT_NOT_FOUND" }),
      );
    });
  });

  test("project-local outcome доступен до появления connection.json", async () => {
    await withExchangeDirectory(async (root) => {
      const databasePath = join(root, ".relay", "project.sqlite");
      const directory = stateDirectory(databasePath);
      let operations: ControlOperations | undefined;
      const owner = await ownControl(
        join(directory, "worker.json"),
        "request",
        databasePath,
        async () => {
          if (operations === undefined) {
            throw new Error("Owner ещё не готов");
          }
          return operations.get("before-config");
        },
      );
      operations = new ControlOperations(directory, owner.endpoint.instance);
      try {
        operations.submit("before-config", "status", "status", async (started) => {
          started();
          return { marker: "retained" };
        });
        await operations.settled();

        const outcome = await getOperation(directory, "before-config", owner.endpoint);

        expect(outcome).toMatchObject({
          state: "completed",
          requestId: "before-config",
          result: { marker: "retained" },
        });
        expect(existsSync(join(directory, "connection.json"))).toBe(false);
      } finally {
        await operations.settled();
        await owner.close();
      }
    });
  });

  test("отмена explicit ожидания сохраняет terminal push-unknown, корреляцию и исходную ошибку ожидания", async () => {
    await withExchangeDirectory(async (root) => {
      const home = join(root, "home");
      mkdirSync(home);
      const options = { cwd: root, home: join(root, "runtime-home") };
      const location = initializeProject({ ...options, name: "Terminal explicit outcome" });
      const directory = stateDirectory(location.databasePath);
      const config = configuration(location, options, join(root, "remote.git"), "relay-data");
      const initial = ProjectDatabase.open(location.databasePath);
      let outbox: ReturnType<ProjectDatabase["getReplicationOutbox"]>;
      try {
        outbox = initial.getReplicationOutbox();
      } finally {
        initial.close();
      }
      const controller = new AbortController();
      const entered = Promise.withResolvers<void>();
      const id = "cancelled-push-outcome";
      const commit = "f".repeat(40);
      const primary = new RelayError("GIT_PUSH_OUTCOME_UNKNOWN", "Push требует проверки", 4, {
        commit,
      });
      // Git заменён только на границе cycle: SQLite, listener, журнал и внешний classifier настоящие.
      const discovery = spyOn(projectConnection, "discoverProjectConnection").mockResolvedValue(
        config,
      );
      const initialize = spyOn(DataRepository.prototype, "initialize").mockResolvedValue(undefined);
      /**
       * После наблюдаемого старта ждёт отмены общего signal и передаёт владельцу значимый terminal отказ.
       */
      async function failAfterAbort(_refresh?: boolean, signal?: AbortSignal): Promise<void> {
        if (signal === undefined) {
          throw new Error("Cycle не получил signal владельца");
        }
        entered.resolve();
        if (!signal.aborted) {
          await new Promise<void>((resolve) =>
            signal.addEventListener("abort", () => resolve(), { once: true }),
          );
        }
        throw primary;
      }
      const run = spyOn(SyncEngine.prototype, "run").mockImplementation(failAfterAbort);
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
        await Promise.race([
          entered.promise,
          completion.then(() => {
            throw new Error("Обращение завершилось до контролируемого cycle");
          }),
        ]);

        controller.abort("SIGTERM");
        const [outcome] = await completion;
        const retained = readOperation(directory, id);

        expect(outcome).toMatchObject({
          status: "rejected",
          reason: {
            code: "GIT_PUSH_OUTCOME_UNKNOWN",
            exitCode: 4,
            details: { requestId: id, state: "failed", commit, instance: retained.instance },
          },
        });
        if (outcome?.status !== "rejected" || !(outcome.reason instanceof Error)) {
          throw new Error("Ожидался terminal отказ explicit операции");
        }
        expect(outcome.reason.cause).toMatchObject({
          errors: [
            { code: "GIT_PUSH_OUTCOME_UNKNOWN", details: { requestId: id, commit } },
            { code: "GIT_CANCELLED", details: { requestId: id, state: "unknown" } },
          ],
        });
        expect(retained).toMatchObject({
          requestId: id,
          state: "failed",
          error: { code: "GIT_PUSH_OUTCOME_UNKNOWN", exitCode: 4, details: { commit } },
        });
        expect(existsSync(join(directory, "worker.json"))).toBe(false);
        const reopened = ProjectDatabase.open(location.databasePath);
        try {
          expect(reopened.getReplicationOutbox()).toEqual(outbox);
        } finally {
          reopened.close();
        }
      } finally {
        controller.abort();
        await completion;
        run.mockRestore();
        initialize.mockRestore();
        discovery.mockRestore();
      }
    });
  });

  test("deadline auto отменяет уже worktree initialize и освобождает владельца", async () => {
    await withGitRepository(async (remote, root, env) => {
      const project = await createLocalProject(join(root, "project"), remote.options.remote, env);
      const connection = new Database(project.location.databasePath, {
        readwrite: true,
        strict: true,
      });
      try {
        connection
          .query(
            "UPDATE synchronization_schedule SET dirty_since=0,last_mutation_at=0,next_attempt_at=0 WHERE singleton=1",
          )
          .run();
      } finally {
        connection.close();
      }
      let initializationSignal: AbortSignal | undefined;
      /**
       * Удерживает настоящий prepare до отмены owner; страховочный сигнал завершит и дефектную реализацию.
       */
      async function stalledInitialization(this: DataRepository): Promise<void> {
        initializationSignal = this.options.signal;
        const signals = [AbortSignal.timeout(3000)];
        if (initializationSignal !== undefined) {
          signals.push(initializationSignal);
        }
        const signal = AbortSignal.any(signals);
        if (!signal.aborted) {
          await new Promise<void>((resolve) =>
            signal.addEventListener("abort", () => resolve(), { once: true }),
          );
        }
        throw new RelayError("GIT_CANCELLED", "Контролируемая отмена initialize", 1);
      }
      const initialize = spyOn(DataRepository.prototype, "initialize").mockImplementation(
        stalledInitialization,
      );
      const directory = stateDirectory(project.location.databasePath);
      const config = {
        ...configuration(
          project.location,
          { cwd: project.root, home: join(project.root, "home") },
          remote.options.remote,
          "relay-data",
        ),
        worktree: project.root,
        mode: "auto" as const,
      };
      const pending = project.replication.status().pending;
      try {
        await expect(
          oneShot({
            directory,
            config,
            replication: project.replication,
            refresh: false,
            id: "cancel-initialize",
            timeoutMs: 1000,
            mode: "automatic",
          }),
        ).rejects.toMatchObject({ code: "GIT_CANCELLED" });

        expect(initializationSignal?.aborted).toBe(true);
        expect(project.replication.status().pending).toBe(pending);
        expect(existsSync(join(directory, "worker.json"))).toBe(false);
        expect(project.replication.schedule().failures).toBe(1);
      } finally {
        initialize.mockRestore();
        project.database.close();
      }
    });
  }, 10_000);
});
