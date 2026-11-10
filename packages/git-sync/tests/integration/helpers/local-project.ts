import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { ProjectDatabase } from "@relay/core";
import { initializeProject, restoreProject } from "@relay/project-runtime";
import type { PortableProjectSnapshot } from "@relay/contracts";
import { git, requireGit } from "../../../src/transport/git";
import { DataRepository } from "../../../src/transport/repository";
import { ReplicationAdapter, restoreSnapshot } from "../../../src/sync/replication-adapter";
import { SyncEngine } from "../../../src/sync/engine";
import type { LocalProjectReplica } from "./local-project.types";

/**
 * Создаёт пустой Git checkout и новую SQLite либо независимую реплику принятого Core checkpoint.
 * У реплики собственные HOME/RELAY_HOME; Git config передаётся fixture явно.
 * При отказе соединение закрывается; успешный результат передаёт владение database вызывающему.
 */
export async function createLocalProject(
  root: string,
  remote: string,
  env: Readonly<Record<string, string | undefined>>,
  snapshot?: PortableProjectSnapshot,
): Promise<LocalProjectReplica> {
  mkdirSync(root);
  const home = join(root, "os-home");
  mkdirSync(home);
  const gitEnvironment = { ...env, HOME: home, USERPROFILE: home, RELAY_HOME: join(root, "home") };
  requireGit(
    await git(root, ["init", "--initial-branch=main", "."], { env: gitEnvironment }),
    "fixture-code",
  );
  requireGit(
    await git(root, ["remote", "add", "origin", remote], { env: gitEnvironment }),
    "fixture-origin",
  );
  const options = { cwd: root, home: join(root, "home") };
  const location =
    snapshot === undefined
      ? initializeProject({ ...options, name: "Локальная реплика" })
      : restoreProject(options, snapshot.projectId, (path) =>
          restoreSnapshot(path, snapshot, { trustedCheckpoint: true }),
        );
  const database = ProjectDatabase.open(location.databasePath);
  try {
    const replication = new ReplicationAdapter(database);
    const repository = new DataRepository({
      directory: join(dirname(location.databasePath), "data"),
      remote,
      branch: "relay-data",
      worktree: {
        projectDirectory: root,
        projectId: location.projectId,
        replicaId: replication.status().replicaId,
      },
      env: gitEnvironment,
    });
    await repository.initialize();
    return {
      root,
      location,
      database,
      replication,
      repository,
      engine: new SyncEngine(
        join(dirname(location.databasePath), "state"),
        location.projectId,
        replication,
        repository,
        new AbortController().signal,
      ),
    };
  } catch (error) {
    database.close();
    throw error;
  }
}
