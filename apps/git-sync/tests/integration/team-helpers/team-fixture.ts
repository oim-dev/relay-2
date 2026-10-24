import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { ProjectDatabase } from "@relay/core";
import type { PortableProjectSnapshot } from "@relay/contracts";
import { SyncEngine } from "../../../src/sync/engine";
import { ReplicationAdapter, restoreSnapshot } from "../../../src/sync/replication-adapter";
import { git, requireGit } from "../../../src/transport/git";
import type { RepositoryOptions } from "../../../src/transport/repository.types";
import { TeamRepository } from "./publication-barrier";
import type { TeamFixture, TeamFixtureOptions, TeamReplica } from "./team-fixture.types";
import { runExchangeProcess } from "../helpers/crash-exchange";
import type { ExchangeProcessObservation } from "../helpers/crash-exchange.types";
import { withGitProcessRuntime } from "../../../src/transport/process-runtime";
import { TeamDiagnostics } from "./team-diagnostics";

const FIXTURE_DEADLINE_MS = 240_000;
const GIT_DEADLINE_MS = 10_000;
const EXCHANGE_BUDGET = 2;

/**
 * Создаёт один origin и независимые SQLite/Git по запросу сценария.
 * Общий deadline отменяет Git и барьеры; finally ждёт остановки engines до закрытия БД.
 * После отказа сохраняет bounded диагностику; optional callback получает путь готового отчёта.
 * Сценарий может сократить общий deadline, оставляя запас до watchdog Bun для полной очистки.
 */
export async function withTeamFixture(
  run: (fixture: TeamFixture) => Promise<void>,
  onFailure?: (path: string) => void,
  options: TeamFixtureOptions = {},
): Promise<void> {
  const now = new Date();
  const date = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0"),
  ].join("-");
  const artifacts = resolve(
    import.meta.dir,
    "../../../../..",
    ".artifacts",
    date,
    "git-sync-implementation/team",
  );
  mkdirSync(artifacts, { recursive: true });
  const root = mkdtempSync(join(artifacts, "replicas-"));
  const diagnostics = new TeamDiagnostics(root, artifacts);
  let failed = false;
  let failure: unknown;
  const origin = join(root, "origin.git");
  const originHome = join(root, "origin-home");
  mkdirSync(originHome);
  const branch = "relay-team-data";
  const replicas: TeamReplica[] = [];
  const databases = new Set<ProjectDatabase>();
  const cancellation = new AbortController();
  const deadline = setTimeout(
    () => cancellation.abort(new Error("Истёк deadline конечной командной приёмки")),
    options.deadlineMs ?? FIXTURE_DEADLINE_MS,
  );
  const originOptions = {
    signal: cancellation.signal,
    timeoutMs: GIT_DEADLINE_MS,
    env: {
      HOME: originHome,
      RELAY_HOME: join(originHome, "relay"),
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_TRACE2_EVENT: diagnostics.tracePath,
    },
  };

  /**
   * Подключает новое соединение к уже существующим транспортным файлам этого участника.
   */
  function attach(replica: TeamReplica, db: ProjectDatabase): void {
    databases.add(db);
    replica.db = db;
    replica.replication = new ReplicationAdapter(db);
    replica.engine = diagnostics.engine(
      replica.index,
      replica.directory,
      new SyncEngine(
        replica.directory,
        db.projectId,
        replica.replication,
        replica.repository,
        cancellation.signal,
      ),
    );
  }

  /**
   * Освобождает соединение перед повторным открытием; активная сеть здесь запрещена.
   */
  function close(replica: TeamReplica): void {
    if (replica.engine.busy) {
      throw new Error("Нельзя менять соединение участника во время обмена");
    }
    replica.db.close();
    databases.delete(replica.db);
  }

  try {
    await withGitProcessRuntime(
      async () => {
        try {
          requireGit(
            await git(root, ["init", "--bare", "--initial-branch=main", origin], originOptions),
            "team-origin",
          );
          await run({
            origin,
            branch,
            replicas,
            signal: cancellation.signal,
            /**
             * Новая реплика получает собственные пути, replicaId и проверенный общий baseline.
             */
            async replica(snapshot): Promise<TeamReplica> {
              const index = replicas.length;
              const directory = join(root, `participant-${index}`);
              const home = join(directory, "home");
              const relayHome = join(directory, "relay-home");
              mkdirSync(home, { recursive: true });
              mkdirSync(relayHome);
              const path = join(relayHome, "project.sqlite");
              const db = snapshot
                ? ProjectDatabase.createReplica(path, snapshot.projectId)
                : ProjectDatabase.create(path, {
                    id: "team-project",
                    name: "Команда",
                    slug: "team",
                  });
              databases.add(db);
              const replication = new ReplicationAdapter(db);
              if (snapshot) {
                replication.core.bootstrap(snapshot);
              }
              const options = {
                directory: join(directory, "repository.git"),
                remote: origin,
                branch,
                signal: cancellation.signal,
                timeoutMs: GIT_DEADLINE_MS,
                env: {
                  HOME: home,
                  RELAY_HOME: relayHome,
                  GIT_CONFIG_NOSYSTEM: "1",
                  GIT_TRACE2_EVENT: diagnostics.tracePath,
                },
              } satisfies RepositoryOptions;
              const repository = new TeamRepository(options);
              const replica = {
                index,
                directory,
                home,
                relayHome,
                db,
                replication,
                repository,
                engine: diagnostics.engine(
                  index,
                  directory,
                  new SyncEngine(
                    directory,
                    db.projectId,
                    replication,
                    repository,
                    cancellation.signal,
                  ),
                ),
              };
              replicas.push(replica);
              await repository.initialize();
              return replica;
            },
            /**
             * Имитирует завершение локального приложения без копирования SQLite/WAL.
             */
            reopen(replica): void {
              const path = replica.db.path;
              close(replica);
              attach(replica, ProjectDatabase.open(path));
            },
            /**
             * Закрывает только подготовительное соединение; crash произойдёт у нового владельца SQLite.
             * После ожидания exit новый repository не наследует cached refs погибшего владельца.
             */
            async exchangeInProcess(replica, attempt): Promise<ExchangeProcessObservation> {
              const path = replica.db.path;
              const { signal: _signal, ...repository } = replica.repository.options;
              close(replica);
              try {
                return await runExchangeProcess(
                  { ...attempt, databasePath: path, directory: replica.directory, repository },
                  cancellation.signal,
                );
              } finally {
                replica.repository = new TeamRepository({
                  ...repository,
                  signal: cancellation.signal,
                });
                attach(replica, ProjectDatabase.open(path));
              }
            },
            /**
             * Использует реальный app/Core bootstrap; только принятые данные могут быть восстановлены.
             */
            restore(replica, snapshot: PortableProjectSnapshot): void {
              if (replica.replication.core.status().pending !== 0) {
                throw new Error("Fixture не разрешает терять pending при восстановлении");
              }
              close(replica);
              const path = join(replica.relayHome, "restored.sqlite");
              restoreSnapshot(path, snapshot, { trustedCheckpoint: true });
              attach(replica, ProjectDatabase.open(path));
            },
            /**
             * Читает только специально созданный origin настоящим Git.
             */
            async originGit(args): Promise<string> {
              return requireGit(await git(origin, args, originOptions), "team-origin-assertion");
            },
          });
        } finally {
          cancellation.abort();
          await Promise.allSettled(replicas.map((replica) => replica.engine.settled()));
          for (const db of databases) {
            db.close();
          }
        }
      },
      join(root, "process-runtime"),
      (observation) => diagnostics.observe(observation),
    );
  } catch (error) {
    failed = true;
    failure = error;
    throw error;
  } finally {
    clearTimeout(deadline);
    cancellation.abort();
    if (failed) {
      try {
        const path = diagnostics.failure(failure);
        onFailure?.(path);
        console.error(`Диагностика конечного обмена: ${path}`);
      } catch (error) {
        console.error("Не удалось сохранить диагностику конечного обмена:", error);
      }
    }
    rmSync(root, { recursive: true, force: true });
  }
}

/**
 * Получает конечную волну с максимум двумя одновременными engines.
 * Ошибка передаётся после остановки всей текущей пары, поэтому cleanup не гоняется с Git.
 */
export async function exchangeTeam(replicas: readonly TeamReplica[]): Promise<void> {
  for (let index = 0; index < replicas.length; index += EXCHANGE_BUDGET) {
    const results = await Promise.allSettled(
      replicas.slice(index, index + EXCHANGE_BUDGET).map((replica) => replica.engine.run()),
    );
    for (const result of results) {
      if (result.status === "rejected") {
        throw result.reason;
      }
    }
  }
}
