import { existsSync, lstatSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { RelayError } from "@relay/contracts";
import {
  hasProjectGit,
  openProject,
  type ProjectLocation,
  type RuntimeOptions,
} from "@relay/project-runtime";
import {
  configuration,
  dataDirectory,
  homeDirectory,
  readConfiguration,
  updateConfiguration,
} from "../local/state";
import type { SyncConfiguration } from "../local/state.types";
import { absoluteRemote, checkGit, git, requireGit } from "../transport/git";
import type { RepositoryOptions } from "../transport/repository.types";
import { DEFAULT_DATA_BRANCH } from "../local/state.constants";
import { connectionMessages as messages } from "./project-connection.messages";
import { appMessages } from "./app.messages";
import type { ReplicationAdapter } from "../sync/replication-adapter";
import { requireGitExecutionActive } from "../execution/context";
import { gitDirectoryIdentity } from "../transport/git-directory-identity";

/**
 * Требует подключение; отсутствие origin не превращается в фиктивный remote.
 */
export function connected(config: SyncConfiguration | null): SyncConfiguration {
  if (config === null) {
    throw new RelayError("GIT_SYNC_NOT_CONNECTED", appMessages.notConnected, 4);
  }
  return config;
}

/**
 * Сравнивает только адресат обмена. Mode может изменяться независимо.
 */
function sameConnection(left: SyncConfiguration, right: SyncConfiguration): boolean {
  return (
    left.projectId === right.projectId &&
    left.databasePath === right.databasePath &&
    left.remote === right.remote &&
    left.branch === right.branch &&
    left.gitCommonDirectory === right.gitCommonDirectory &&
    left.gitCommonDirectoryIdentity === right.gitCommonDirectoryIdentity &&
    left.remoteName === right.remoteName
  );
}

/**
 * Под уже удерживаемым transport mutex сохраняет discovery с текущим SQLite mode.
 * Конкурентная смена адресата даёт PROJECT_CHANGED, а не переписывает новое подключение старым снимком.
 * До claim проверяет оставшийся data worktree незавершённого connect, даже без connection.json.
 * Это не позволяет discovery из другого clone вмешаться в подключение активного owner.
 */
export async function saveDiscoveredConnection(
  directory: string,
  discovered: SyncConfiguration,
  expected: SyncConfiguration | null,
  replication: ReplicationAdapter,
): Promise<SyncConfiguration> {
  const options = {
    cwd: dirname(discovered.configPath),
    config: discovered.configPath,
    home: discovered.home,
  };
  if (discovered.gitCommonDirectory !== undefined) {
    const current = readConfiguration(directory);
    requireSameGitRepository(
      current,
      discovered.gitCommonDirectory,
      discovered.gitCommonDirectoryIdentity,
    );
    await requireExistingDataRepository(
      discovered.databasePath,
      discovered.gitCommonDirectory,
      current,
    );
  }
  requireGitExecutionActive();
  requireProjectReplica(options, discovered, replication.status().replicaId);
  const saved = updateConfiguration(directory, (current) => {
    if (
      current !== null &&
      !sameConnection(current, discovered) &&
      (expected === null || !sameConnection(current, expected))
    ) {
      throw new RelayError("PROJECT_CHANGED", appMessages.projectChanged, 4);
    }
    return {
      ...(current !== null && sameConnection(current, discovered) ? current : discovered),
      mode: replication.schedule().mode,
    };
  });
  // Config текущего обращения нужен guards, но смена worktree не переписывает transport binding.
  return {
    ...saved,
    configPath: discovered.configPath,
    worktree: discovered.worktree,
    home: discovered.home,
  };
}

/**
 * До сохранения первого подключения проверяет Git-владельца оставшегося data worktree.
 * Failed connect уже мог создать worktree, но ещё не публиковать connection.json.
 * Чужой либо повреждённый .git даёт отказ без claim; известный owner проверен через сохранённую identity.
 * Вызывающий удерживает transport mutex, чтобы другой connect не создавал data между проверкой и записью.
 */
export async function requireExistingDataRepository(
  databasePath: string,
  commonDirectory: string,
  saved: SyncConfiguration | null,
): Promise<void> {
  if (saved?.gitCommonDirectory !== undefined) {
    return;
  }
  const directory = dataDirectory(databasePath);
  const pointer = lstatSync(join(directory, ".git"), { throwIfNoEntry: false });
  if (pointer === undefined) {
    return;
  }
  if (!pointer.isFile() || (await projectGitCommonDirectory(directory)) !== commonDirectory) {
    throw new RelayError("GIT_REPOSITORY_MISMATCH", messages.repository, 4);
  }
}

/**
 * Возвращает физический Git common-dir: общий для linked worktree, разный у независимых клонов.
 * Не требует origin и не использует путь checkout как идентификатор репозитория.
 */
export async function projectGitCommonDirectory(directory: string): Promise<string> {
  return realpathSync(
    requireGit(
      await git(directory, ["rev-parse", "--path-format=absolute", "--git-common-dir"]),
      "project-common-directory",
    ),
  );
}

/**
 * Запрещает присваивать существующую локальную реплику независимому Git-клону с тем же projectId.
 * Rename того же common-dir разрешён только по сохранённой физической идентичности, не по ID/URL.
 * Незавершённое подключение без Git common-dir ещё не закрепляет владельца транспорта.
 */
export function requireSameGitRepository(
  saved: SyncConfiguration | null,
  gitCommonDirectory: string,
  identity: string = gitDirectoryIdentity(gitCommonDirectory),
): void {
  if (
    saved?.gitCommonDirectoryIdentity !== undefined
      ? saved.gitCommonDirectoryIdentity !== identity
      : saved?.gitCommonDirectory !== undefined && saved.gitCommonDirectory !== gitCommonDirectory
  ) {
    throw new RelayError("GIT_REPOSITORY_MISMATCH", messages.repository, 4);
  }
}

/**
 * Под transport mutex повторно сверяет Runtime binding, replicaId и выбранное подключение перед Git.
 * Проверочное соединение всегда закрывается; не подменяет соединение уже открытой предметной операции.
 */
export function requireCurrentProject(
  directory: string,
  config: SyncConfiguration,
  replication: ReplicationAdapter,
): void {
  requireProjectReplica(
    {
      cwd: dirname(config.configPath),
      config: config.configPath,
      home: config.home,
    },
    config,
    replication.status().replicaId,
  );
  const current = readConfiguration(directory);
  if (current !== null && !sameConnection(current, config)) {
    throw new RelayError("PROJECT_CHANGED", appMessages.projectChanged, 4);
  }
}

/**
 * Под mutex сверяет текущий Runtime выбор с открытой репликой даже при отсутствии Git-подключения.
 */
export function requireProjectReplica(
  options: RuntimeOptions,
  expected: Readonly<ProjectLocation>,
  replicaId: string,
): void {
  const selected = openProject(options);
  try {
    if (
      selected.location.projectId !== expected.projectId ||
      realpathSync(selected.location.databasePath) !== realpathSync(expected.databasePath) ||
      realpathSync(selected.location.configPath) !== realpathSync(expected.configPath) ||
      selected.database.getReplicationStatus().replicaId !== replicaId
    ) {
      throw new RelayError("PROJECT_CHANGED", appMessages.projectChanged, 4);
    }
  } finally {
    selected.database.close();
  }
}

/**
 * Читает живой origin из Git проекта, включая добавленный после init; отсутствие возвращает null.
 * Разные fetch/push URL и несколько адресов отвергаются до сети, чтобы fetch доказывал целевой push.
 */
export async function projectOrigin(directory: string, name = "origin"): Promise<string | null> {
  if (!hasProjectGit(directory)) {
    return null;
  }
  requireGit(await git(directory, ["rev-parse", "--show-toplevel"]), "project-repository");
  const result = await git(directory, ["remote", "get-url", "--all", name]);
  if (result.exitCode === 2) {
    return null;
  }
  checkGit(result, "project-remote");
  const push = await git(directory, ["remote", "get-url", "--push", "--all", name]);
  checkGit(push, "project-push-remote");
  // Удаляется только разделитель Git: пробел в конце локального remote может быть частью имени каталога.
  const fetchUrl = result.stdout.toString("utf8").replace(/\r?\n$/, "");
  const pushUrl = push.stdout.toString("utf8").replace(/\r?\n$/, "");
  if (fetchUrl.length === 0 || fetchUrl.includes("\n") || fetchUrl !== pushUrl) {
    throw new RelayError("GIT_ORIGIN_MISMATCH", messages.urls, 4);
  }
  return absoluteRemote(directory, fetchUrl);
}

/**
 * При явном connect/restore создаёт Git-контекст без code commit; существующие repo/remote не переписывает.
 * Возвращает true только для собственного нового Git-контекста с указанным origin.
 */
export async function initializeProjectRepository(root: string, remote: string): Promise<boolean> {
  if (hasProjectGit(root)) {
    return false;
  }
  requireGit(await git(root, ["init", "--initial-branch=main", "."]), "project-git-init");
  requireGit(await git(root, ["remote", "add", "origin", remote]), "project-git-origin");
  return true;
}

/**
 * Готовит подключение наследуемого origin без сети; поздняя смена URL проверяется обычной историей Core.
 * Перенос каталога допускается, когда прежний путь БД исчез; существующая копия не становится той же репликой.
 */
export async function discoverProjectConnection(
  location: ProjectLocation,
  options: RuntimeOptions,
  saved: SyncConfiguration | null,
): Promise<SyncConfiguration | null> {
  if (saved !== null && saved.projectId !== location.projectId) {
    throw new RelayError("GIT_REPLICA_MISMATCH", messages.replica, 4);
  }
  const root = dirname(realpathSync(location.configPath));
  if (!hasProjectGit(root)) {
    return null;
  }
  const gitCommonDirectory = await projectGitCommonDirectory(root);
  const gitCommonDirectoryIdentity = gitDirectoryIdentity(gitCommonDirectory);
  requireSameGitRepository(saved, gitCommonDirectory, gitCommonDirectoryIdentity);
  if (
    saved &&
    saved.databasePath !== realpathSync(location.databasePath) &&
    existsSync(saved.databasePath)
  ) {
    throw new RelayError("GIT_REPLICA_MISMATCH", messages.replica, 4);
  }
  const remoteName = saved?.remoteName ?? (saved === null ? "origin" : undefined);
  const remote = remoteName === undefined ? saved?.remote : await projectOrigin(root, remoteName);
  if (remote === null || remote === undefined) {
    return null;
  }
  return {
    ...configuration(location, options, remote, saved?.branch ?? DEFAULT_DATA_BRANCH),
    ...saved,
    databasePath: realpathSync(location.databasePath),
    configPath: realpathSync(location.configPath),
    worktree: root,
    gitCommonDirectory,
    gitCommonDirectoryIdentity,
    home: homeDirectory(options),
    remote,
    mode: saved?.mode ?? "auto",
    ...(remoteName === undefined ? {} : { remoteName }),
  };
}

/**
 * Выбирает один служебный worktree рядом с SQLite, общий для всех checkout этой локальной реплики.
 * Git-контекст берётся из common-dir, поэтому удаление вызывавшего linked worktree не меняет владельца.
 */
export function projectRepositoryOptions(
  directory: string,
  config: SyncConfiguration,
  replicaId: string,
  signal?: AbortSignal,
): RepositoryOptions {
  return {
    directory: dataDirectory(config.databasePath),
    stateDirectory: directory,
    remote: config.remote,
    branch: config.branch,
    ...(signal === undefined ? {} : { signal }),
    worktree: {
      projectDirectory: config.gitCommonDirectory ?? config.worktree,
      ...(config.gitCommonDirectoryIdentity === undefined
        ? {}
        : { commonDirectoryIdentity: config.gitCommonDirectoryIdentity }),
      replicaId,
      projectId: config.projectId,
    },
  };
}
