import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { openProject, type RuntimeOptions } from "@relay/project-runtime";
import { KnowledgeService, ReplicationService, type ProjectDatabase } from "@relay/core";
import { withProcessFixture } from "./process-fixture";
import { stateDirectory } from "../../src/local/state";
import { runProcess } from "../../src/transport/process";
import { git, requireGit } from "../../src/transport/git";

/**
 * Дожидается предметной операции и закрывает соединение даже при отказе async writer.
 */
async function withProjectDatabase<T>(
  options: RuntimeOptions,
  operation: (database: ProjectDatabase) => T | Promise<T>,
): Promise<T> {
  const opened = openProject(options);
  try {
    return await operation(opened.database);
  } finally {
    opened.database.close();
  }
}

describe("Процессный порт Git Sync в CLI", () => {
  test("wire-envelope принимает пользовательский JSON 8 MiB с options без усечения", async () => {
    await withProcessFixture(async (fixture) => {
      const result = await fixture.request({ cwd: fixture.root }, "unknown-action", {
        payload: "x".repeat(8 * 1024 * 1024),
      });

      expect(result).toMatchObject({
        ok: false,
        error: { code: "GIT_SYNC_UNKNOWN_ACTION", exitCode: 2 },
      });
    });
  }, 15_000);

  test.skipIf(process.platform === "win32")(
    "cached status не запускает даже локальный Git subprocess",
    async () => {
      await withProcessFixture(async (fixture) => {
        const project = fixture.context("cached-status");
        expect(
          (await fixture.request(project.options, "connect", { remote: fixture.remote })).ok,
        ).toBe(true);
        expect((await fixture.request(project.options, "now")).ok).toBe(true);
        const shim = join(fixture.root, "status-shim");
        const marker = join(fixture.root, "unexpected-git");
        mkdirSync(shim);
        writeFileSync(join(shim, "git"), `#!/bin/sh\nprintf called > '${marker}'\nexit 97\n`, {
          mode: 0o700,
        });

        const result = await fixture.request(
          project.options,
          "status",
          {},
          { PATH: `${shim}:${process.env.PATH ?? ""}` },
        );

        expect(result).toMatchObject({ ok: true, data: { git: { ahead: 0, behind: 0 } } });
        expect(existsSync(marker)).toBe(false);
      });
    },
    15_000,
  );

  test("несовместимый JSON protocol отвечает одним JSON и exit 2 без открытия проекта", async () => {
    await withProcessFixture(async ({ root, binary }) => {
      const result = await runProcess({
        executable: binary,
        args: ["--git-sync-request"],
        cwd: root,
        input: '{"version":2}',
      });

      expect(result.exitCode).toBe(2);
      expect(result.stderr.toString()).toBe("");
      expect(JSON.parse(result.stdout.toString())).toMatchObject({
        version: 1,
        ok: false,
        error: { code: "GIT_SYNC_PROTOCOL_VERSION", exitCode: 2 },
      });
    });
  });

  test("restore создаёт новую независимую реплику из explicit remote без code Git и не заменяет рабочую БД", async () => {
    await withProcessFixture(async (fixture) => {
      const first = fixture.context("first");
      const { document, firstReplica } = await withProjectDatabase(
        first.options,
        async (database) => ({
          document: await new KnowledgeService(database).create(
            "document",
            { name: "Восстановить", body: "\ud800\r\n\tточно\n" },
            "author",
          ),
          firstReplica: new ReplicationService(database).status().replicaId,
        }),
      );
      expect((await fixture.request(first.options, "connect", { remote: fixture.remote })).ok).toBe(
        true,
      );
      expect((await fixture.request(first.options, "now")).ok).toBe(true);
      const second = fixture.context("second", false);

      const restored = await fixture.request(second.options, "restore", { remote: fixture.remote });

      expect(restored.ok).toBe(true);
      const replica = openProject(second.options);
      try {
        expect(replica.database.get(document.id)?.data.body).toBe("\ud800\r\n\tточно\n");
        const status = new ReplicationService(replica.database).status();
        expect(status.replicaId).not.toBe(firstReplica);
        expect(status.pending).toBe(0);
      } finally {
        replica.database.close();
      }
      const repeated = await fixture.request(second.options, "restore", { remote: fixture.remote });
      expect(repeated).toMatchObject({ ok: false, error: { code: "DATABASE_EXISTS" } });
      await withProjectDatabase(second.options, (database) => {
        expect(database.get(document.id)?.data.body).toBe("\ud800\r\n\tточно\n");
      });
    });
  }, 15_000);

  test("auto получает remote при пустом outbox, manual сохраняет поздний pending до явного now", async () => {
    await withProcessFixture(async (fixture) => {
      const source = fixture.context("source");
      expect(
        await fixture.request(source.options, "connect", { remote: fixture.remote }),
      ).toMatchObject({ ok: true, data: { connected: true } });
      expect(await fixture.request(source.options, "now")).toMatchObject({
        ok: true,
        data: { pending: { changesets: 0 } },
      });
      const target = fixture.context("target", false);
      expect(
        await fixture.request(target.options, "restore", { remote: fixture.remote }),
      ).toMatchObject({ ok: true, data: { restored: true } });
      const added = await withProjectDatabase(source.options, (database) =>
        new KnowledgeService(database).create(
          "feature",
          { name: "Пришло без local write" },
          "source",
        ),
      );
      expect(await fixture.request(source.options, "now")).toMatchObject({
        ok: true,
        data: { pending: { changesets: 0 } },
      });
      await withProjectDatabase(target.options, (database) => {
        expect(database.getReplicationStatus().pending).toBe(0);
        database.completeSynchronizationAttempt({ at: 0, nextAttemptAt: 0, failed: false });
      });

      const imported = await fixture.request(target.options, "auto");

      expect(imported).toMatchObject({ ok: true, data: { state: "completed", pending: 0 } });
      expect(
        await withProjectDatabase(target.options, (database) => database.get(added.id)?.data.name),
      ).toBe("Пришло без local write");
      expect(await fixture.request(target.options, "auto.disable")).toMatchObject({
        ok: true,
        data: { mode: "manual" },
      });
      const local = await withProjectDatabase(target.options, (database) =>
        new KnowledgeService(database).create("feature", { name: "Только локально" }, "target"),
      );
      const before = requireGit(
        await git(fixture.remote, ["rev-parse", "refs/heads/relay-data"]),
        "remote-before-manual",
      );

      const disabled = await fixture.request(target.options, "auto");
      const status = await fixture.request(target.options, "status");

      expect(disabled).toMatchObject({ ok: true, data: { state: "deferred", reason: "disabled" } });
      expect(status).toMatchObject({
        ok: true,
        data: { mode: "manual", pending: { changesets: 1, unexported: 1 } },
      });
      expect(
        requireGit(
          await git(fixture.remote, ["rev-parse", "refs/heads/relay-data"]),
          "remote-after-manual",
        ),
      ).toBe(before);
      expect(
        await withProjectDatabase(target.options, (database) => database.get(local.id)?.data.name),
      ).toBe("Только локально");

      expect(await fixture.request(target.options, "now")).toMatchObject({
        ok: true,
        data: { mode: "manual", pending: { changesets: 0 } },
      });
    });
  }, 30_000);

  test("restore без remote использует сохранённое подключение после утраты локальной БД", async () => {
    await withProcessFixture(async (fixture) => {
      const original = fixture.context("lost");
      if (!original.location) {
        throw new Error("Ожидался созданный проект fixture");
      }
      const { document, replicaId } = await withProjectDatabase(
        original.options,
        async (database) => ({
          document: await new KnowledgeService(database).create(
            "document",
            { name: "Сохранено в Git", body: "Содержимое утраченной реплики" },
            "author",
          ),
          replicaId: new ReplicationService(database).status().replicaId,
        }),
      );
      const branch = "saved-connection-data";
      expect(
        await fixture.request(original.options, "connect", { remote: fixture.remote, branch }),
      ).toMatchObject({ ok: true, data: { connected: true, branch } });
      expect(await fixture.request(original.options, "now")).toMatchObject({
        ok: true,
        data: { pending: { changesets: 0 } },
      });
      const connectionPath = join(
        stateDirectory(original.location.databasePath),
        "connection.json",
      );
      const savedConnection = readFileSync(connectionPath, "utf8");
      // Теряем только SQLite-семью fixture, сохраняя соседний state/ и подключение.
      for (const suffix of ["", "-wal", "-shm", "-journal"]) {
        rmSync(`${original.location.databasePath}${suffix}`, { force: true });
      }
      expect(readFileSync(connectionPath, "utf8")).toBe(savedConnection);

      const result = await fixture.request(original.options, "restore");

      expect(result).toMatchObject({
        ok: true,
        data: { restored: true, projectId: original.location.projectId, branch },
      });
      const projectId = original.location.projectId;
      await withProjectDatabase(original.options, (database) => {
        expect(database.projectId).toBe(projectId);
        expect(database.get(document.id)?.data.body).toBe("Содержимое утраченной реплики");
        const status = new ReplicationService(database).status();
        expect(status.replicaId).not.toBe(replicaId);
        expect(status.pending).toBe(0);
      });
    });
  }, 15_000);
});
