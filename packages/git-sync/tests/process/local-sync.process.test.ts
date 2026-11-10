import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { KnowledgeService, ProjectDatabase } from "@relay/core";
import type { ProjectLocation } from "@relay/project-runtime";
import { git, requireGit } from "../../src/transport/git";
import { withProcessFixture } from "./process-fixture";
import { acquireControlLock, ownControl } from "../../src/local/control";

/**
 * Задаёт контролируемые durable часы вместо sleep между отдельными процессами CLI.
 */
function makeDue(location: ProjectLocation, nextAttemptAt = 0): void {
  const connection = new Database(location.databasePath, { readwrite: true, strict: true });
  try {
    connection
      .query(
        "UPDATE synchronization_schedule SET dirty_since=0,last_mutation_at=0,next_attempt_at=? WHERE singleton=1",
      )
      .run(nextAttemptAt);
  } finally {
    connection.close();
  }
}

/**
 * Изолирует пользовательский Git config/HOME всех дочерних Git и component процессов теста.
 */
function gitEnvironment(home: string): Record<string, string> {
  const config = join(home, "gitconfig");
  writeFileSync(config, "");
  return { HOME: home, USERPROFILE: home, GIT_CONFIG_GLOBAL: config, GIT_CONFIG_NOSYSTEM: "1" };
}

/**
 * Читает остаток реальной durable очереди после завершения отдельного процесса.
 */
function pending(location: ProjectLocation): number {
  const database = ProjectDatabase.open(location.databasePath);
  try {
    return database.getReplicationStatus().pending;
  } finally {
    database.close();
  }
}

describe("Одноразовый межпроцессный обмен", () => {
  test.skipIf(process.platform === "win32")(
    "origin сохраняет значимый пробел в конце локального URL",
    async () => {
      await withProcessFixture(async (fixture) => {
        const { options, location } = fixture.context("remote-space");
        if (location === null || options.home === undefined) {
          throw new Error("Ожидался проект");
        }
        const env = gitEnvironment(options.home);
        const remote = join(fixture.root, "remote.git ");
        requireGit(
          await git(fixture.root, ["init", "--bare", remote], { env }),
          "remote-with-space",
        );
        expect(await fixture.request(options, "connect", { remote }, env)).toMatchObject({
          ok: true,
        });

        const result = await fixture.request(options, "now", {}, env);

        expect(result).toMatchObject({ ok: true, data: { pending: { changesets: 0 } } });
        expect(
          (
            await git(
              fixture.remote,
              ["show-ref", "--verify", "--quiet", "refs/heads/relay-data"],
              { env },
            )
          ).exitCode,
        ).toBe(1);
        expect(
          requireGit(
            await git(remote, ["rev-list", "--count", "refs/heads/relay-data"], { env }),
            "published-remote",
          ),
        ).toBe("1");
      });
    },
    30_000,
  );

  test("auto без remote не переписывает расписание активного transport owner", async () => {
    await withProcessFixture(async (fixture) => {
      const { options, location } = fixture.context("no-remote-owner");
      if (location === null || options.home === undefined) {
        throw new Error("Ожидался проект");
      }
      const env = gitEnvironment(options.home);
      makeDue(location);
      const database = ProjectDatabase.open(location.databasePath);
      let lock: ReturnType<typeof acquireControlLock> | undefined;
      try {
        lock = acquireControlLock(join(dirname(location.databasePath), "state", "worker.json"));
        const before = database.getSynchronizationSchedule();

        const result = await fixture.request(options, "auto", {}, env);

        expect(result).toMatchObject({ ok: true, data: { state: "deferred", reason: "busy" } });
        expect(database.getSynchronizationSchedule()).toEqual(before);
      } finally {
        try {
          lock?.release();
        } finally {
          database.close();
        }
      }
    });
  }, 15_000);

  test("мертвый endpoint старого пути не блокирует now после переноса проекта", async () => {
    await withProcessFixture(async (fixture) => {
      const { options, location } = fixture.context("dead-owner-move");
      if (location === null || options.home === undefined) {
        throw new Error("Ожидался проект");
      }
      const env = gitEnvironment(options.home);
      expect(
        await fixture.request(options, "connect", { remote: fixture.remote }, env),
      ).toMatchObject({ ok: true });
      expect(await fixture.request(options, "now", {}, env)).toMatchObject({ ok: true });
      const endpointPath = join(dirname(location.databasePath), "state", "worker.json");
      const owner = await ownControl(
        endpointPath,
        "request",
        location.databasePath,
        async () => null,
      );
      const endpoint = owner.endpoint;
      await owner.close();
      // Имитируется crash: endpoint остался, но настоящий listener и SQLite mutex уже освобождены.
      writeFileSync(endpointPath, JSON.stringify(endpoint));
      const root = join(fixture.root, "moved-with-database");
      renameSync(options.cwd, root);

      const result = await fixture.request({ ...options, cwd: root }, "now", {}, env);

      expect(result).toMatchObject({ ok: true, data: { pending: { changesets: 0 } } });
      expect(existsSync(options.cwd)).toBe(false);
      expect(existsSync(endpointPath)).toBe(false);
    });
  }, 30_000);

  test("restore отклоняет dirty worktree до публикации утраченной SQLite", async () => {
    await withProcessFixture(async (fixture) => {
      const { options, location } = fixture.context("restore-dirty");
      if (location === null || options.home === undefined) {
        throw new Error("Ожидался проект");
      }
      const env = gitEnvironment(options.home);
      expect(
        await fixture.request(options, "connect", { remote: fixture.remote }, env),
      ).toMatchObject({ ok: true });
      expect(await fixture.request(options, "now", {}, env)).toMatchObject({ ok: true });
      const config = readFileSync(location.configPath, "utf8");
      const manifest = join(dirname(location.databasePath), "data", "manifest.json");
      writeFileSync(manifest, "ручная правка\n");
      rmSync(location.databasePath);

      const result = await fixture.request(options, "restore", {}, env);

      expect(result).toMatchObject({ ok: false, error: { code: "GIT_SYNC_WORKTREE_DIRTY" } });
      expect(existsSync(location.databasePath)).toBe(false);
      expect(readFileSync(location.configPath, "utf8")).toBe(config);
      expect(readFileSync(manifest, "utf8")).toBe("ручная правка\n");
    });
  }, 30_000);

  test("restore после переноса использует актуальный root и не создаёт старый каталог", async () => {
    await withProcessFixture(async (fixture) => {
      const { options, location } = fixture.context("restore-moved");
      if (location === null || options.home === undefined) {
        throw new Error("Ожидался проект");
      }
      const env = gitEnvironment(options.home);
      expect(
        await fixture.request(options, "connect", { remote: fixture.remote }, env),
      ).toMatchObject({ ok: true });
      expect(await fixture.request(options, "now", {}, env)).toMatchObject({ ok: true });
      rmSync(location.databasePath);
      const root = join(fixture.root, "moved-project");
      renameSync(options.cwd, root);
      const current = { ...options, cwd: root };

      const result = await fixture.request(current, "restore", {}, env);

      expect(result).toMatchObject({
        ok: true,
        data: {
          restored: true,
          projectId: location.projectId,
          databasePath: location.databasePath,
          configPath: join(root, "relay.config.json"),
        },
      });
      expect(existsSync(options.cwd)).toBe(false);
      expect(existsSync(join(dirname(location.databasePath), "data", "manifest.json"))).toBe(true);
      expect(await fixture.request(current, "now", {}, env)).toMatchObject({
        ok: true,
        data: { pending: { changesets: 0 } },
      });
    });
  }, 30_000);

  test("replay operationId не начинает новый cycle поверх dirty worktree", async () => {
    await withProcessFixture(async (fixture) => {
      const { options, location } = fixture.context("replay");
      if (location === null || options.home === undefined) {
        throw new Error("Ожидался проект");
      }
      const env = gitEnvironment(options.home);
      expect(
        await fixture.request(options, "connect", { remote: fixture.remote }, env),
      ).toMatchObject({ ok: true });
      const original = await fixture.request(
        options,
        "now",
        { operationId: "published-once" },
        env,
      );
      const database = ProjectDatabase.open(location.databasePath);
      try {
        await new KnowledgeService(database).create(
          "document",
          { name: "Поздний", body: "Ещё не публиковать" },
          "author",
        );
      } finally {
        database.close();
      }
      const manifest = join(dirname(location.databasePath), "data", "manifest.json");
      writeFileSync(manifest, "не перезаписывать\n");

      const repeated = await fixture.request(
        options,
        "now",
        { operationId: "published-once" },
        env,
      );

      expect(original.ok).toBe(true);
      expect(repeated).toEqual(original);
      expect(pending(location)).toBe(1);
      expect(readFileSync(manifest, "utf8")).toBe("не перезаписывать\n");
    });
  }, 30_000);

  test("project-local now не читает даже повреждённый supervisor endpoint", async () => {
    await withProcessFixture(async (fixture) => {
      const { options, location } = fixture.context("local-budget");
      if (location === null || options.home === undefined) {
        throw new Error("Ожидался проект");
      }
      const env = gitEnvironment(options.home);
      mkdirSync(join(options.home, "git-sync"));
      writeFileSync(join(options.home, "git-sync", "supervisor.json"), "намеренно неверный JSON");
      expect(
        await fixture.request(options, "connect", { remote: fixture.remote }, env),
      ).toMatchObject({ ok: true });

      const result = await fixture.request(options, "now", {}, env);

      expect(result).toMatchObject({ ok: true, data: { pending: { changesets: 0 } } });
      expect(existsSync(join(dirname(location.databasePath), "state", "worker.json"))).toBe(false);
    });
  }, 30_000);

  test("auto disable до появления remote сохраняется, а now остаётся доступен", async () => {
    await withProcessFixture(async (fixture) => {
      const { options, location } = fixture.context("disabled-before-origin");
      if (location === null || options.home === undefined) {
        throw new Error("Ожидался созданный проект");
      }
      const env = gitEnvironment(options.home);

      expect(await fixture.request(options, "auto.disable", {}, env)).toMatchObject({
        ok: true,
        data: { mode: "manual", connected: false },
      });
      requireGit(
        await git(options.cwd, ["init", "--initial-branch=main", "."], { env }),
        "init-code",
      );
      requireGit(
        await git(options.cwd, ["remote", "add", "origin", fixture.remote], { env }),
        "add-origin",
      );
      makeDue(location);
      expect(await fixture.request(options, "auto", {}, env)).toMatchObject({
        ok: true,
        data: { state: "deferred", reason: "disabled" },
      });
      expect(await fixture.request(options, "now", {}, env)).toMatchObject({
        ok: true,
        data: { pending: { changesets: 0 }, mode: "manual" },
      });
      expect(await fixture.request(options, "auto.enable", {}, env)).toMatchObject({
        ok: true,
        data: { mode: "auto" },
      });
      makeDue(location);
      expect(await fixture.request(options, "auto", {}, env)).toMatchObject({
        ok: true,
        data: { state: "completed", pending: 0 },
      });
      expect(existsSync(join(options.home, "git-sync", "supervisor.json"))).toBe(false);
    });
  }, 30_000);

  test("restore создаёт независимую SQLite и linked worktree в другом RELAY_HOME", async () => {
    await withProcessFixture(async (fixture) => {
      const first = fixture.context("first");
      const second = fixture.context("second", false);
      if (
        first.location === null ||
        first.options.home === undefined ||
        second.options.home === undefined
      ) {
        throw new Error("Ожидался исходный проект");
      }
      const env = gitEnvironment(first.options.home);
      requireGit(
        await git(first.options.cwd, ["init", "--initial-branch=main", "."], { env }),
        "init-code",
      );
      requireGit(
        await git(first.options.cwd, ["remote", "add", "origin", fixture.remote], { env }),
        "add-origin",
      );
      expect(await fixture.request(first.options, "now", {}, env)).toMatchObject({ ok: true });
      const head = requireGit(
        await git(fixture.remote, ["rev-parse", "refs/heads/relay-data"], { env }),
        "published-head",
      );
      const source = ProjectDatabase.open(first.location.databasePath);
      let sourceReplica: string;
      try {
        sourceReplica = source.getReplicationStatus().replicaId;
      } finally {
        source.close();
      }

      const result = await fixture.request(
        second.options,
        "restore",
        { remote: fixture.remote },
        gitEnvironment(second.options.home),
      );
      const targetPath = join(
        second.options.home,
        "projects",
        first.location.projectId,
        "project.sqlite",
      );

      expect(result).toMatchObject({
        ok: true,
        data: {
          restored: true,
          projectId: first.location.projectId,
          databasePath: targetPath,
          branch: "relay-data",
        },
      });
      expect(existsSync(join(dirname(targetPath), "data", "manifest.json"))).toBe(true);
      expect(existsSync(join(second.options.cwd, ".git"))).toBe(true);
      const target = ProjectDatabase.open(targetPath);
      let targetReplica: string;
      try {
        targetReplica = target.getReplicationStatus().replicaId;
      } finally {
        target.close();
      }
      expect(targetReplica).not.toBe(sourceReplica);
      expect(
        requireGit(
          await git(second.options.cwd, ["rev-parse", `refs/relay/${targetReplica}/accepted`], {
            env,
          }),
          "restored-cursor",
        ),
      ).toBe(head);
      expect(
        await fixture.request(second.options, "now", {}, gitEnvironment(second.options.home)),
      ).toMatchObject({ ok: true, data: { pending: { changesets: 0 } } });
    });
  }, 40_000);

  test("локальная работа до origin доставляется следующим обращением после добавления remote", async () => {
    await withProcessFixture(async (fixture) => {
      const { options, location } = fixture.context("late-origin");
      if (location === null || options.home === undefined) {
        throw new Error("Ожидался созданный проект");
      }
      const env = gitEnvironment(options.home);
      requireGit(
        await git(options.cwd, ["init", "--initial-branch=main", "."], { env }),
        "init-code",
      );
      const database = ProjectDatabase.open(location.databasePath);
      let documentId: string;
      try {
        documentId = (
          await new KnowledgeService(database).create(
            "document",
            { name: "До remote", body: "Устойчивая локальная запись" },
            "author",
          )
        ).id;
      } finally {
        database.close();
      }
      makeDue(location);
      const originalPending = pending(location);

      const offline = await fixture.request(options, "auto", {}, env);

      expect(offline).toMatchObject({ ok: true, data: { state: "deferred", reason: "no-remote" } });
      expect(pending(location)).toBe(originalPending);
      requireGit(
        await git(options.cwd, ["remote", "add", "origin", fixture.remote], { env }),
        "add-origin",
      );
      makeDue(location);
      const published = await fixture.request(options, "auto", {}, env);

      expect(published).toMatchObject({ ok: true, data: { state: "completed", pending: 0 } });
      expect(pending(location)).toBe(0);
      expect(existsSync(join(dirname(location.databasePath), "data", "manifest.json"))).toBe(true);
      expect(existsSync(join(dirname(location.databasePath), "state", "worker.json"))).toBe(false);
      expect(existsSync(join(options.home, "git-sync", "supervisor.json"))).toBe(false);
      const restored = ProjectDatabase.open(location.databasePath);
      try {
        expect(restored.get(documentId)?.data.body).toBe("Устойчивая локальная запись");
      } finally {
        restored.close();
      }
      expect(
        requireGit(
          await git(fixture.remote, ["rev-list", "--count", "refs/heads/relay-data"], { env }),
          "remote-count",
        ),
      ).toBe("1");
    });
  }, 30_000);

  test("now обходит будущий debounce и сохраняет проверяемый request outcome", async () => {
    await withProcessFixture(async (fixture) => {
      const { options, location } = fixture.context("forced-now");
      if (location === null || options.home === undefined) {
        throw new Error("Ожидался созданный проект");
      }
      const env = gitEnvironment(options.home);
      requireGit(
        await git(options.cwd, ["init", "--initial-branch=main", "."], { env }),
        "init-code",
      );
      requireGit(
        await git(options.cwd, ["remote", "add", "origin", fixture.remote], { env }),
        "add-origin",
      );
      makeDue(location, Date.now() + 60_000);

      const automatic = await fixture.request(options, "auto", {}, env);
      const explicit = await fixture.request(options, "now", { operationId: "forced-now" }, env);

      expect(automatic).toMatchObject({
        ok: true,
        data: { state: "deferred", reason: "debounce" },
      });
      expect(explicit).toMatchObject({
        ok: true,
        data: { requestId: "forced-now", pending: { changesets: 0 } },
      });
      expect(
        await fixture.request(options, "request.get", { requestId: "forced-now" }, env),
      ).toMatchObject({
        ok: true,
        data: { state: "completed", requestId: "forced-now", action: "now" },
      });
      expect(await fixture.request(options, "auto", {}, env)).toMatchObject({
        ok: true,
        data: { state: "deferred", reason: "debounce" },
      });
    });
  }, 30_000);

  test("одновременные автоматические обращения объединяются в одну публикацию", async () => {
    await withProcessFixture(async (fixture) => {
      const { options, location } = fixture.context("concurrent-auto");
      if (location === null || options.home === undefined) {
        throw new Error("Ожидался созданный проект");
      }
      const env = gitEnvironment(options.home);
      requireGit(
        await git(options.cwd, ["init", "--initial-branch=main", "."], { env }),
        "init-code",
      );
      requireGit(
        await git(options.cwd, ["remote", "add", "origin", fixture.remote], { env }),
        "add-origin",
      );
      makeDue(location);

      const results = await Promise.all([
        fixture.request(options, "auto", {}, env),
        fixture.request(options, "auto", {}, env),
      ]);

      expect(results.every((result) => result.ok)).toBe(true);
      expect(pending(location)).toBe(0);
      expect(
        requireGit(
          await git(fixture.remote, ["rev-list", "--count", "refs/heads/relay-data"], { env }),
          "remote-count",
        ),
      ).toBe("1");
      expect(existsSync(join(dirname(location.databasePath), "state", "worker.json"))).toBe(false);
    });
  }, 30_000);

  test("одновременные now сериализуются и оба получают собственный успешный исход", async () => {
    await withProcessFixture(async (fixture) => {
      const { options, location } = fixture.context("concurrent-now");
      if (location === null || options.home === undefined) {
        throw new Error("Ожидался созданный проект");
      }
      const env = gitEnvironment(options.home);
      requireGit(
        await git(options.cwd, ["init", "--initial-branch=main", "."], { env }),
        "init-code",
      );
      requireGit(
        await git(options.cwd, ["remote", "add", "origin", fixture.remote], { env }),
        "add-origin",
      );

      const results = await Promise.all([
        fixture.request(options, "now", { operationId: "first" }, env),
        fixture.request(options, "now", { operationId: "second" }, env),
      ]);

      expect(results[0]).toMatchObject({ ok: true, data: { requestId: "first" } });
      expect(results[1]).toMatchObject({ ok: true, data: { requestId: "second" } });
      expect(pending(location)).toBe(0);
      expect(
        requireGit(
          await git(fixture.remote, ["rev-list", "--count", "refs/heads/relay-data"], { env }),
          "remote-count",
        ),
      ).toBe("1");
    });
  }, 30_000);
});
