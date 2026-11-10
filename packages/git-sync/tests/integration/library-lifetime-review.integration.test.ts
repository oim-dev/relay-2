import { describe, expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import * as files from "node:fs";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  watch,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { initializeProject, currentNativePlatform } from "@relay/project-runtime";
import * as runtime from "@relay/project-runtime";
import { ProjectDatabase } from "@relay/storage";
import { executeGitSyncRequest } from "../../src/index";
import { stateDirectory } from "../../src/local/state";
import { COMPONENT_RELEASE } from "../../src/local/control";
import { writeLocalJson } from "../../src/local/files";
import { git, requireGit } from "../../src/transport/git";
import { DataRepository } from "../../src/transport/repository";
import { runProcess } from "../../src/transport/process";
import * as processRuntime from "../../src/transport/process-runtime";
import { requestObject } from "../../src/app/protocol";
import { RelayError, type PortableProjectSnapshot } from "@relay/contracts";
import { containsFailure } from "./helpers/source-runtime-fixture";
import { withGitExecution } from "../../src/execution/context";
import { prepareRestoration } from "../../src/app/restore-preparation";
import { ReplicationAdapter } from "../../src/sync/replication-adapter";
import { encodeSnapshot } from "../../src/snapshot/codec";

const sourceCleanupOutcomes = [
  { name: "после успешного callback", callbackFailed: false },
  { name: "после ошибки отменённого callback", callbackFailed: true },
] as const;

/**
 * Изолирует cwd, HOME, RELAY_HOME и Git-конфигурацию execution-проверки, затем удаляет каталог.
 * Callback закрывает handles/owners и снимает fault injection до возврата, включая отказ assertions.
 */
async function withLibraryDirectory(
  operation: (root: string, env: Record<string, string | undefined>) => Promise<void>,
): Promise<void> {
  const parent = fileURLToPath(
    new URL(
      `../../../../.artifacts/${new Date().toISOString().slice(0, 10)}/project-local-sync/library-review/fixtures/`,
      import.meta.url,
    ),
  );
  mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(join(parent, "execution-"));
  const home = join(root, "home");
  mkdirSync(home);
  const config = join(home, "gitconfig");
  writeFileSync(config, "");
  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    RELAY_HOME: join(root, "relay-home"),
    GIT_CONFIG_GLOBAL: config,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_COUNT: undefined,
    GIT_CONFIG_PARAMETERS: undefined,
  };
  try {
    await operation(root, env);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/**
 * Наблюдает атомарно публикуемый marker по событию ФС; отмена закрывает watcher, без sleep/polling.
 */
function filePublished(path: string, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const watcher = watch(dirname(path), check);
    /**
     * Освобождает оба механизма ожидания при успехе и отказе.
     */
    function finish(error?: unknown): void {
      watcher.close();
      signal.removeEventListener("abort", aborted);
      if (error !== undefined) {
        reject(error);
      } else {
        resolve();
      }
    }
    /**
     * Marker появляется только после rename полностью записанного файла.
     */
    function check(): void {
      if (existsSync(path)) {
        finish();
      }
    }
    /**
     * Функциональный deadline не оставляет незавершённый watcher при раннем отказе команды.
     */
    function aborted(): void {
      finish(signal.reason);
    }
    watcher.on("error", finish);
    signal.addEventListener("abort", aborted, { once: true });
    if (signal.aborted) {
      aborted();
    } else {
      check();
    }
  });
}

describe("Lifetime библиотечного обращения Git Sync", () => {
  test("отменённое локальное чтение не превращается в поздний успешный ответ", async () => {
    await withLibraryDirectory(async (root, env) => {
      const options = { cwd: root, home: join(root, "home") };
      initializeProject({ ...options, name: "Cancelled read" });
      const controller = new AbortController();

      const operation = executeGitSyncRequest(
        { version: 1, action: "status", options },
        { env, signal: controller.signal },
      );
      controller.abort("SIGTERM");

      await expect(operation).rejects.toMatchObject({ code: "GIT_SYNC_CANCELLED", exitCode: 143 });
    });
  });

  test("отмена после discovery без remote не записывает расписание и не возвращает success", async () => {
    await withLibraryDirectory(async (root, env) => {
      const options = { cwd: root, home: join(root, "home") };
      const location = initializeProject({ ...options, name: "Отмена без origin" });
      const clock = new Database(location.databasePath, { readwrite: true, strict: true });
      try {
        clock
          .query(
            "UPDATE synchronization_schedule SET dirty_since=0,last_mutation_at=0,next_attempt_at=0 WHERE singleton=1",
          )
          .run();
      } finally {
        clock.close();
      }
      const database = ProjectDatabase.open(location.databasePath);
      try {
        const before = database.getSynchronizationSchedule();
        const controller = new AbortController();

        const operation = executeGitSyncRequest(
          { version: 1, action: "auto", options },
          { env, signal: controller.signal },
        );
        controller.abort("SIGTERM");
        const outcome = await Promise.allSettled([operation]);

        expect(database.getSynchronizationSchedule()).toEqual(before);
        expect(outcome[0]).toMatchObject({
          status: "rejected",
          reason: { code: "GIT_SYNC_CANCELLED", exitCode: 143 },
        });
      } finally {
        database.close();
      }
    });
  });

  test("поздняя замена options.signal не меняет источник отмены принятого запроса", async () => {
    await withLibraryDirectory(async (root, env) => {
      const options = { cwd: root, home: join(root, "home") };
      initializeProject({ ...options, name: "Signal snapshot" });
      const original = new AbortController();
      const replacement = new AbortController();
      const execution = { env, signal: original.signal };

      const operation = executeGitSyncRequest(
        { version: 1, action: "now", options, input: { operationId: "captured-signal" } },
        execution,
      );
      execution.signal = replacement.signal;
      original.abort("SIGTERM");

      await expect(operation).rejects.toMatchObject({
        code: "GIT_SYNC_CANCELLED",
        exitCode: 143,
        details: { requestId: "captured-signal" },
      });
      expect(replacement.signal.aborted).toBe(false);
    });
  });

  test("caller cancellation прерывает control HTTP, а не ждёт его отдельного timeout", async () => {
    await withLibraryDirectory(async (root, env) => {
      const options = { cwd: root, home: join(root, "home") };
      const location = initializeProject({ ...options, name: "Control cancellation" });
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const disconnected = Promise.withResolvers<void>();
      const server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        /**
         * Удерживает только ответ read-only operation.get до отмены клиента либо cleanup теста.
         */
        async fetch(request): Promise<Response> {
          request.signal.addEventListener("abort", () => disconnected.resolve(), { once: true });
          entered.resolve();
          await release.promise;
          return Response.json({
            version: 1,
            ok: true,
            data: { version: 1, state: "unknown", requestId: "observed", instance: "held-owner" },
          });
        },
      });
      const directory = stateDirectory(location.databasePath);
      writeLocalJson(join(directory, "worker.json"), {
        version: 1,
        release: COMPONENT_RELEASE,
        kind: "request",
        identity: location.databasePath,
        instance: "held-owner",
        pid: process.pid,
        port: server.port,
        capability: "fixture-capability",
        startedAt: new Date().toISOString(),
      });
      const controller = new AbortController();
      const operation = executeGitSyncRequest(
        { version: 1, action: "request.get", options, input: { requestId: "observed" } },
        { env, signal: controller.signal },
      );
      const outcome = Promise.allSettled([operation]);
      let safety: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          entered.promise,
          outcome.then(() => {
            throw new Error("Обращение завершилось до control HTTP");
          }),
        ]);
        const stopped = Promise.race([
          disconnected.promise.then(() => true),
          new Promise<boolean>((resolve) => {
            safety = setTimeout(() => resolve(false), 1000);
          }),
        ]);

        controller.abort("SIGTERM");

        expect(await stopped).toBe(true);
        expect((await outcome)[0]).toMatchObject({
          status: "rejected",
          reason: { code: "GIT_SYNC_CANCELLED", exitCode: 143, details: { requestId: "observed" } },
        });
      } finally {
        clearTimeout(safety);
        release.resolve();
        controller.abort();
        await outcome;
        await server.stop(true);
      }
    });
  }, 10_000);

  test("публичный scope завершает реального ребёнка и удаляет helper до возврата отмены", async () => {
    await withLibraryDirectory(async (root, env) => {
      const options = { cwd: root, home: join(root, "home") };
      const location = initializeProject({ ...options, name: "Owned child" });
      const initialDatabase = ProjectDatabase.open(location.databasePath);
      let outbox: ReturnType<ProjectDatabase["getReplicationOutbox"]>;
      try {
        outbox = initialDatabase.getReplicationOutbox();
      } finally {
        initialDatabase.close();
      }
      const remote = join(root, "remote.git");
      await processRuntime.withGitProcessRuntime(async () => {
        requireGit(await git(root, ["init", "--bare", remote], { env }), "remote");
        requireGit(await git(root, ["init", "--initial-branch=main", "."], { env }), "code");
        requireGit(await git(root, ["remote", "add", "origin", remote], { env }), "origin");
      });
      const helper = join(root, "request-helper");
      const originalRuntime = processRuntime.withGitProcessRuntime;
      const scopedRuntime = spyOn(processRuntime, "withGitProcessRuntime").mockImplementation(
        (operation) => originalRuntime(operation, helper),
      );
      const ready = join(root, "child-ready.json");
      const script = `import {writeFileSync,renameSync} from 'node:fs';writeFileSync(${JSON.stringify(ready + ".tmp")},JSON.stringify({scope:process.env.RELAY_LIBRARY_REVIEW,pid:process.pid}));renameSync(${JSON.stringify(ready + ".tmp")},${JSON.stringify(ready)});setInterval(()=>{},1000);`;
      /**
       * Заменяет только Git initialization на управляемую длинную команду через тот же production runner.
       */
      async function heldInitialization(this: DataRepository): Promise<void> {
        await runProcess({
          executable: process.execPath,
          args: ["-e", script],
          cwd: root,
          ...(this.options.signal === undefined ? {} : { signal: this.options.signal }),
        });
      }
      const initialization = spyOn(DataRepository.prototype, "initialize").mockImplementation(
        heldInitialization,
      );
      const controller = new AbortController();
      const observer = new AbortController();
      const published = filePublished(
        ready,
        AbortSignal.any([observer.signal, AbortSignal.timeout(8000)]),
      );
      const inputEnv = { ...env, RELAY_LIBRARY_REVIEW: "captured" };
      const operation = executeGitSyncRequest(
        { version: 1, action: "now", options, input: { operationId: "owned-child" } },
        { env: inputEnv, signal: controller.signal },
      );
      const outcome = Promise.allSettled([operation]);
      inputEnv.RELAY_LIBRARY_REVIEW = "changed-after-call";
      try {
        await Promise.race([
          published,
          outcome.then(() => {
            throw new Error("Обращение завершилось до запуска тестового ребёнка");
          }),
        ]);
        const child = requestObject(JSON.parse(readFileSync(ready, "utf8")));
        const pid = child.pid;
        if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid < 1) {
          throw new Error("Ребёнок не опубликовал PID");
        }
        expect(child.scope).toBe("captured");
        expect(existsSync(helper)).toBe(true);

        controller.abort("SIGTERM");
        const result = await outcome;

        expect(result[0]).toMatchObject({
          status: "rejected",
          reason: {
            code: "GIT_SYNC_CANCELLED",
            exitCode: 143,
            details: { requestId: "owned-child" },
          },
        });
        // Проверяется именно отсутствие процесса; SIGTERM callback не гарантируется при grace=0 транспорта.
        expect(() => process.kill(pid, 0)).toThrow(expect.objectContaining({ code: "ESRCH" }));
        expect(existsSync(helper)).toBe(false);
        expect(existsSync(join(stateDirectory(location.databasePath), "worker.json"))).toBe(false);
        const database = ProjectDatabase.open(location.databasePath);
        try {
          expect(database.getReplicationOutbox()).toEqual(outbox);
        } finally {
          database.close();
        }
      } finally {
        observer.abort();
        controller.abort();
        await published.catch(() => {});
        await outcome;
        initialization.mockRestore();
        scopedRuntime.mockRestore();
      }
    });
  }, 20_000);

  test.each(sourceCleanupOutcomes)(
    "source cleanup failure $name не превращается в обычную отмену",
    async ({ callbackFailed }) => {
      await withLibraryDirectory(async (root, env) => {
        const options = { cwd: root, home: join(root, "home") };
        initializeProject({ ...options, name: "Source cleanup" });
        const helper = join(root, "request-helper");
        const controller = new AbortController();
        const cleanup = Object.assign(new Error("Source helper не удалён"), { code: "EACCES" });
        const primary = new RelayError("GIT_CANCELLED", "Callback прерван", 1);
        const actualRemove = files.rmSync;
        const removal = spyOn(files, "rmSync").mockImplementation((path, options) => {
          if (path === helper) {
            throw cleanup;
          }
          actualRemove(path, options);
        });
        const originalRuntime = processRuntime.withGitProcessRuntime;
        /**
         * Создаёт реальный helper короткой командой и отменяет caller после callback, до source cleanup.
         * При необходимости добавляет primary failure; helper и команда по-прежнему принадлежат production scope.
         */
        async function cancelAfterCallback<T>(operation: () => Promise<T>): Promise<T> {
          const command = await runProcess({
            executable: process.execPath,
            args: ["-e", ""],
            cwd: root,
          });
          expect(command.exitCode).toBe(0);
          const result = await operation();
          controller.abort("SIGTERM");
          if (callbackFailed) {
            throw primary;
          }
          return result;
        }
        const scopedRuntime = spyOn(processRuntime, "withGitProcessRuntime").mockImplementation(
          (operation) => originalRuntime(() => cancelAfterCallback(operation), helper),
        );
        try {
          const failure: unknown = await executeGitSyncRequest(
            { version: 1, action: "status", options },
            { env, signal: controller.signal },
          ).catch((error: unknown) => error);

          expect(controller.signal.aborted).toBe(true);
          expect(existsSync(helper)).toBe(true);
          expect(failure).toBeInstanceOf(Error);
          expect(failure).not.toMatchObject({ code: "GIT_SYNC_CANCELLED" });
          expect(containsFailure(failure, cleanup)).toBe(true);
          if (callbackFailed) {
            expect(containsFailure(failure, primary)).toBe(true);
          }
        } finally {
          scopedRuntime.mockRestore();
          removal.mockRestore();
        }
      });
    },
  );

  test("отмена после Git-подготовки останавливает Core bootstrap до создания private SQLite", async () => {
    await withLibraryDirectory(async (root, env) => {
      const location = initializeProject({
        cwd: root,
        home: join(root, "home"),
        name: "Bootstrap cancellation",
      });
      const database = ProjectDatabase.open(location.databasePath);
      let snapshot: PortableProjectSnapshot;
      try {
        snapshot = new ReplicationAdapter(database).prepare(null).snapshot;
      } finally {
        database.close();
      }
      const directory = join(root, "preparation");
      mkdirSync(directory);
      const controller = new AbortController();
      const head = "a".repeat(40);
      // Git не является предметом этой проверки; decoder, validation Core и SQLite bootstrap остаются настоящими.
      const initialize = spyOn(DataRepository.prototype, "initialize").mockResolvedValue(undefined);
      const fetch = spyOn(DataRepository.prototype, "fetch").mockResolvedValue(head);
      const files = spyOn(DataRepository.prototype, "files").mockResolvedValue(
        encodeSnapshot(snapshot),
      );
      const acceptedCommit = spyOn(DataRepository.prototype, "acceptedCommit").mockResolvedValue(
        null,
      );
      const history = spyOn(DataRepository.prototype, "history").mockResolvedValue([
        { head, parent: null },
      ]);
      const accepted = spyOn(DataRepository.prototype, "accepted").mockImplementation(async () => {
        controller.abort("SIGTERM");
      });
      try {
        const failure: unknown = await withGitExecution({ env, signal: controller.signal }, () =>
          prepareRestoration({
            directory,
            remote: "fixture://prepared-history",
            branch: "relay-data",
            projectId: location.projectId,
            mode: "auto",
          }),
        ).catch((error: unknown) => error);

        expect(controller.signal.aborted).toBe(true);
        expect(failure).toMatchObject({ code: "GIT_CANCELLED", exitCode: 1 });
        expect(existsSync(join(directory, "project.sqlite"))).toBe(false);
      } finally {
        accepted.mockRestore();
        history.mockRestore();
        acceptedCommit.mockRestore();
        files.mockRestore();
        fetch.mockRestore();
        initialize.mockRestore();
      }
    });
  });

  test("отмена после worktree preflight не публикует SQLite восстановленного проекта", async () => {
    await withLibraryDirectory(async (root, env) => {
      const source = join(root, "source");
      const target = join(root, "target");
      mkdirSync(source);
      mkdirSync(target);
      const remote = join(root, "remote.git");
      const sourceLocation = initializeProject({
        cwd: source,
        home: join(root, "home"),
        name: "Restore source",
      });
      const targetHome = join(root, "target-home");
      const targetStorage = join(targetHome, "projects", sourceLocation.projectId);
      await processRuntime.withGitProcessRuntime(async () => {
        requireGit(await git(root, ["init", "--bare", remote], { env }), "remote");
      });
      await executeGitSyncRequest(
        {
          version: 1,
          action: "connect",
          options: { cwd: source, home: join(root, "home") },
          input: { remote },
        },
        { env },
      );
      await executeGitSyncRequest(
        { version: 1, action: "now", options: { cwd: source, home: join(root, "home") } },
        { env },
      );
      const controller = new AbortController();
      const originalCounts = DataRepository.prototype.counts;
      /**
       * Отменяет после последнего успешного Git-чтения, до публичной SQLite публикации Runtime.
       */
      async function cancelAfterPreflight(
        this: DataRepository,
      ): ReturnType<DataRepository["counts"]> {
        const counts = await originalCounts.call(this);
        if (this.options.directory === join(targetStorage, "data")) {
          controller.abort("SIGTERM");
        }
        return counts;
      }
      const counts = spyOn(DataRepository.prototype, "counts").mockImplementation(
        cancelAfterPreflight,
      );
      try {
        const outcome = await Promise.allSettled([
          executeGitSyncRequest(
            {
              version: 1,
              action: "restore",
              options: { cwd: target, home: targetHome },
              input: { remote },
            },
            { env, signal: controller.signal },
          ),
        ]);

        expect(controller.signal.aborted).toBe(true);
        expect(existsSync(join(targetStorage, "project.sqlite"))).toBe(false);
        expect(existsSync(join(target, "relay.config.json"))).toBe(false);
        expect(existsSync(join(targetStorage, "state", "connection.json"))).toBe(false);
        expect(existsSync(join(targetStorage, "state", "progress.json"))).toBe(false);
        expect(outcome[0]).toMatchObject({
          status: "rejected",
          reason: { code: "GIT_SYNC_CANCELLED", exitCode: 143 },
        });
      } finally {
        counts.mockRestore();
      }
    });
  }, 30_000);

  test.skipIf(currentNativePlatform() === "win32")(
    "ошибка пути после openProject закрывает уже открытое соединение",
    async () => {
      await withLibraryDirectory(async (root, env) => {
        const cwd = join(root, "project");
        mkdirSync(cwd);
        const options = { cwd, home: join(root, "home") };
        initializeProject({ ...options, name: "Move during selection" });
        const originalOpen = runtime.openProject;
        const originalClose = ProjectDatabase.prototype.close;
        let database: ProjectDatabase | undefined;
        let closed = false;
        /**
         * Делегирует реальный close и фиксирует только освобождение выбранного рабочего соединения.
         */
        function observedClose(this: ProjectDatabase): void {
          originalClose.call(this);
          if (this === database) {
            closed = true;
          }
        }
        const close = spyOn(ProjectDatabase.prototype, "close").mockImplementation(observedClose);
        /**
         * Имитирует разрешённый ОС move хранилища сразу после открытия SQLite, до setup приложения.
         */
        function movedSelection(
          input: Parameters<typeof runtime.openProject>[0],
        ): ReturnType<typeof runtime.openProject> {
          const opened = originalOpen(input);
          database = opened.database;
          renameSync(options.home, join(root, "moved-home"));
          return opened;
        }
        const open = spyOn(runtime, "openProject").mockImplementation(movedSelection);
        try {
          const result = await Promise.allSettled([
            executeGitSyncRequest({ version: 1, action: "status", options }, { env }),
          ]);

          expect(result[0]).toMatchObject({ status: "rejected", reason: { code: "ENOENT" } });
          expect(closed).toBe(true);
        } finally {
          open.mockRestore();
          close.mockRestore();
          if (!closed) {
            database?.close();
          }
        }
      });
    },
  );
});
