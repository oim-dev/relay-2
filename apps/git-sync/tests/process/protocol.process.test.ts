import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { existsSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import {
  GuardedCommandError,
  openProject,
  runGuardedCommand,
  type RuntimeOptions,
} from "@relay/project-runtime";
import { KnowledgeService, ReplicationService, type ProjectDatabase } from "@relay/core";
import { withProcessFixture, eventually } from "./process-fixture";
import { requestObject } from "../../src/app/protocol";
import { readEndpoint, responsive } from "../../src/local/control";
import type { ControlEndpoint } from "../../src/local/control.types";
import type { ProcessFixture } from "./process-fixture.types";
import { stateDirectory } from "../../src/local/state";
import { runProcess } from "../../src/transport/process";

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

/**
 * Владеет явным foreground S вне короткого request; readiness подтверждается control-протоколом.
 * Guardian и конечный deadline обеспечивают остановку S и его workers до удаления HOME fixture.
 */
async function withForegroundSupervisor(
  fixture: ProcessFixture,
  options: RuntimeOptions,
  operation: (supervisor: ControlEndpoint) => Promise<void>,
): Promise<void> {
  const home = options.home;
  if (!home) {
    throw new Error("Для supervisor необходим отдельный home fixture");
  }
  const systemHome = join(home, "system-home");
  mkdirSync(systemHome, { recursive: true });
  const endpointPath = join(home, "git-sync", "supervisor.json");
  const cancellation = new AbortController();
  let ended = false;
  const completion = runGuardedCommand({
    component: [fixture.binary],
    argv: [fixture.binary, "supervise", "--home", home, "--parent-lease"],
    cwd: fixture.root,
    env: { ...process.env, HOME: systemHome, RELAY_HOME: home, GIT_CONFIG_NOSYSTEM: "1" },
    stdinLease: true,
    timeoutMs: 40_000,
    maxOutputBytes: 128 * 1024,
    terminationGraceMs: 2000,
    signal: cancellation.signal,
  })
    .then(
      (result) => ({ kind: "completed" as const, result }),
      (error: unknown) => ({ kind: "failed" as const, error }),
    )
    .finally(() => {
      ended = true;
    });
  const failures: unknown[] = [];
  let stoppedByFixture = false;
  try {
    await eventually(async () => {
      if (ended) {
        const outcome = await completion;
        if (outcome.kind === "failed") {
          throw outcome.error;
        }
        throw new Error(
          `Supervisor завершился до readiness: ${outcome.result.code}; ${outcome.result.stderr}`,
        );
      }
      const endpoint = readEndpoint(endpointPath);
      return (
        endpoint !== null &&
        endpoint.kind === "supervisor" &&
        endpoint.identity === realpathSync(home) &&
        (await responsive(endpoint))
      );
    }, 12_000);
    const supervisor = readEndpoint(endpointPath);
    if (!supervisor) {
      throw new Error("Supervisor утратил readiness перед сценарием");
    }
    await operation(supervisor);
  } catch (error) {
    failures.push(error);
  } finally {
    stoppedByFixture = !ended;
    cancellation.abort();
  }
  const outcome = await completion;
  // Guardian сообщает cancelled после завершения дерева при нашей намеренной отмене lease.
  if (
    outcome.kind === "failed" &&
    !(
      stoppedByFixture &&
      outcome.error instanceof GuardedCommandError &&
      outcome.error.reason === "cancelled"
    )
  ) {
    failures.push(outcome.error);
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, "Сценарий или остановка supervisor завершились с ошибкой");
  }
  if (outcome.kind === "completed") {
    expect(outcome.result.code).toBe(0);
  }
  expect(readEndpoint(endpointPath)).toBeNull();
}

describe("Собранный процессный компонент Git Sync", () => {
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
        args: ["--request"],
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

  test("worker имеет одну identity, опрашивает remote без локальных записей и manual оставляет pending", async () => {
    await withProcessFixture(async (fixture) => {
      const source = fixture.context("source");
      expect(
        (await fixture.request(source.options, "connect", { remote: fixture.remote })).ok,
      ).toBe(true);
      expect((await fixture.request(source.options, "now")).ok).toBe(true);
      const target = fixture.context("target", false);
      expect(
        (await fixture.request(target.options, "restore", { remote: fixture.remote })).ok,
      ).toBe(true);
      await withForegroundSupervisor(fixture, target.options, async (supervisor) => {
        const startOutcomes = await Promise.allSettled([
          fixture.request(target.options, "worker.start"),
          fixture.request(target.options, "worker.start"),
        ]);
        const starts = startOutcomes.map((outcome) => {
          if (outcome.status === "rejected") {
            throw outcome.reason;
          }
          return outcome.value;
        });
        for (const result of starts) {
          expect(result.ok).toBe(true);
        }
        const instances = starts.map((result) =>
          result.ok ? requestObject(requestObject(result.data).worker).instance : null,
        );
        expect(instances[0]).toBe(instances[1]);
        expect(typeof instances[0]).toBe("string");
        const targetPath = await withProjectDatabase(target.options, (database) =>
          realpathSync(database.path),
        );
        const workerEndpoint = readEndpoint(join(stateDirectory(targetPath), "worker.json"));
        expect(workerEndpoint).toMatchObject({
          kind: "worker",
          instance: instances[0],
          supervisorInstance: supervisor.instance,
        });
        expect((await fixture.request(target.options, "auto.enable")).ok).toBe(true);
        const added = await withProjectDatabase(source.options, (database) =>
          new KnowledgeService(database).create(
            "feature",
            { name: "Пришло без local write" },
            "source",
          ),
        );

        expect((await fixture.request(source.options, "now")).ok).toBe(true);
        await eventually(() => {
          const targetDb = openProject(target.options);
          try {
            return targetDb.database.get(added.id)?.data.name === "Пришло без local write";
          } finally {
            targetDb.database.close();
          }
        });
        expect((await fixture.request(target.options, "auto.disable")).ok).toBe(true);
        const endpointPath = await withProjectDatabase(target.options, async (database) => {
          await new KnowledgeService(database).create(
            "feature",
            { name: "Только локально" },
            "target",
          );
          return join(stateDirectory(realpathSync(database.path)), "worker.json");
        });
        const status = await fixture.request(target.options, "status");

        expect(status.ok).toBe(true);
        if (status.ok) {
          expect(status.data).toMatchObject({
            mode: "manual",
            worker: { desired: "running", actual: "running", responsive: true },
            git: { ahead: 0, behind: 0 },
            pending: { changesets: 1, unexported: 1 },
          });
        }
        expect((await fixture.request(target.options, "worker.stop")).ok).toBe(true);
        expect(readEndpoint(endpointPath)).toBeNull();
      });
    });
  }, 30_000);

  test("restore без remote использует сохранённое подключение после утраты локальной БД", async () => {
    await withProcessFixture(async (fixture) => {
      const original = fixture.context("lost");
      expect(
        (await fixture.request(original.options, "connect", { remote: fixture.remote })).ok,
      ).toBe(true);
      expect((await fixture.request(original.options, "now")).ok).toBe(true);
      if (!original.location) {
        throw new Error("expected project");
      }
      rmSync(original.location.databasePath);

      const result = await fixture.request(original.options, "restore");

      expect(result.ok).toBe(true);
      const projectId = original.location.projectId;
      await withProjectDatabase(original.options, (database) => {
        expect(database.projectId).toBe(projectId);
        expect(new ReplicationService(database).status().pending).toBe(0);
      });
    });
  }, 15_000);
});
