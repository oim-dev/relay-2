import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ProjectDatabase } from "@relay/core";
import { git, requireGit } from "../../../src/transport/git";
import { DataRepository } from "../../../src/transport/repository";
import { ReplicationAdapter } from "../../../src/sync/replication-adapter";
import { SyncEngine } from "../../../src/sync/engine";
import type { GitFixture, ReplicaFixture } from "./git-fixture.types";

/**
 * Владеет Git/SQLite теста и закрывает все соединения до удаления изолированных файлов.
 * Пользовательские cwd/home/remote не используются; окружение процесса не меняется.
 */
export async function withGitFixture(
  operation: (fixture: GitFixture) => Promise<void>,
  artifactGroup = "git-sync-implementation/git-sync/fixtures",
): Promise<void> {
  const date = new Date().toISOString().slice(0, 10);
  const parent = fileURLToPath(
    new URL(`../../../../../.artifacts/${date}/${artifactGroup}/`, import.meta.url),
  );
  mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(join(parent, "git-"));
  const remote = join(root, "remote.git");
  const databases: ProjectDatabase[] = [];
  const replicas: ReplicaFixture[] = [];
  const cancellation = new AbortController();
  try {
    requireGit(
      await git(root, ["init", "--bare", "--initial-branch=main", remote]),
      "fixture-remote",
    );
    await operation({
      root,
      remote,
      signal: cancellation.signal,
      /**
       * Создаёт минимальное состояние; source предоставляет только checkpoint, принятый реальным engine.
       */
      async replica(name, source, factory): Promise<ReplicaFixture> {
        const directory = join(root, name);
        mkdirSync(directory);
        const home = join(directory, "home");
        const relayHome = join(directory, "relay-home");
        mkdirSync(home);
        mkdirSync(relayHome);
        const checkpoint = source?.replication.acceptedSnapshot();
        if (source && !checkpoint) {
          throw new Error("Источник ещё не принял проверенный checkpoint из общей Git-ветки");
        }
        const db = checkpoint
          ? ProjectDatabase.createReplica(join(relayHome, "project.sqlite"), checkpoint.projectId)
          : ProjectDatabase.create(join(relayHome, "project.sqlite"), {
              id: "project-sync-test",
              name: "sync-test",
              slug: "sync-test",
            });
        databases.push(db);
        const replication = new ReplicationAdapter(db);
        if (checkpoint) {
          // Источник — реальный engine после принятия canonical history, а не capture локальных правок.
          replication.core.bootstrap(checkpoint, { trustedCheckpoint: true });
        }
        const options = {
          directory: join(directory, "repo"),
          remote,
          branch: "relay-data-v2",
          signal: cancellation.signal,
          env: { HOME: home, RELAY_HOME: relayHome, GIT_CONFIG_NOSYSTEM: "1" },
        };
        const repository = factory ? factory(options) : new DataRepository(options);
        await repository.initialize();
        const replica = {
          directory,
          db,
          replication,
          repository,
          engine: new SyncEngine(
            directory,
            db.projectId,
            replication,
            repository,
            cancellation.signal,
          ),
        };
        replicas.push(replica);
        return replica;
      },
    });
  } finally {
    cancellation.abort();
    await Promise.allSettled(replicas.map((replica) => replica.engine.settled()));
    for (const db of databases) {
      db.close();
    }
    rmSync(root, { recursive: true, force: true });
  }
}

/**
 * Ожидает конкретное событие гонки с deadline; снимает обработчик отмены при любом исходе.
 */
export async function waitForGitBarrier(
  event: Promise<void>,
  fixtureSignal: AbortSignal,
): Promise<void> {
  const signal = AbortSignal.any([fixtureSignal, AbortSignal.timeout(8_000)]);
  signal.throwIfAborted();
  const stopped = Promise.withResolvers<never>();
  /**
   * Прерывает ожидание только собственного события теста.
   */
  function abort(): void {
    stopped.reject(signal.reason);
  }
  signal.addEventListener("abort", abort, { once: true });
  try {
    await Promise.race([event, stopped.promise]);
  } finally {
    signal.removeEventListener("abort", abort);
  }
}
