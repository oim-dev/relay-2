import { expect } from "bun:test";
import { nativeExecutableName } from "@relay/project-runtime";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  createWorkflowEnvironment,
  invokeSuccess,
  workflowArtifactsDirectory,
} from "../../../apps/cli/tests/e2e/helpers/workflow-fixture";
import { launchGitSyncSupervisor } from "./git-sync-supervisor";
import type {
  GitSyncFixture,
  GitSyncReplica,
  GitSyncSupervisorProcess,
} from "./git-sync-fixture.types";

const artifacts = join(workflowArtifactsDirectory, "git-sync-implementation/e2e");
const gitSyncBinary = resolve(
  import.meta.dir,
  "../../../apps/git-sync/dist",
  nativeExecutableName("relay-git-sync"),
);

/**
 * Создаёт пустую копию проекта, сохраняя изоляцию HOME существующего workflow fixture.
 * Только продуктовый маршрут получает Git и компонент обмена; общий Git-config неизменяем.
 * При ошибке подготовки освобождает уже созданный каталог самостоятельно.
 */
async function createReplica(root: string): Promise<GitSyncReplica> {
  const environment = await createWorkflowEnvironment(root, {
    RELAY_GIT_SYNC_BIN: gitSyncBinary,
    PATH: process.env.PATH ?? process.env.Path ?? "",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: join(root, ".gitconfig"),
  });
  try {
    const cwd = join(environment.root, "project");
    await mkdir(cwd);
    return { ...environment, cwd };
  } catch (error) {
    await environment.close();
    throw error;
  }
}

/**
 * Создаёт настоящий bare Git без обращения к пользовательской конфигурации и сети.
 * Процесс ограничен deadline; оба потока читаются до освобождения ресурса.
 */
async function createBareRemote(replica: GitSyncReplica, remote: string): Promise<void> {
  const child = Bun.spawn(["git", "init", "--bare", "--quiet", remote], {
    cwd: replica.cwd,
    env: replica.variables,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    timeout: 10_000,
  });
  try {
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect({ code, stdout, stderr }).toEqual({ code: 0, stdout: "", stderr: "" });
  } finally {
    if (child.exitCode === null) {
      child.kill();
      await child.exited;
    }
  }
}

/**
 * Отключает автоматический обмен перед остановкой worker; обе команды выполняются
 * даже при отказе первой. Без endpoint нет адресуемого готового worker; принадлежащий
 * fixture supervisor останавливается отдельным следующим шагом. Нативные службы не вызываются.
 */
async function stopReplicaWorker(replica: GitSyncReplica): Promise<void> {
  const endpoints = await Array.fromAsync(
    new Bun.Glob("home/.relay/**/worker.json").scan({ cwd: replica.root }),
  );
  if (endpoints.length === 0) {
    return;
  }
  const errors: unknown[] = [];
  for (const action of [
    ["auto", "disable"],
    ["worker", "stop"],
  ]) {
    try {
      await invokeSuccess(replica, replica.cwd, ["git-sync", ...action]);
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length > 0) {
    throw new AggregateError(errors, "Не удалось штатно остановить worker сквозного маршрута");
  }
}

/**
 * Выделяет две независимые копии и общий remote без скрытого init/connect/restore.
 * close останавливает workers и foreground supervisors до удаления файлов;
 * ошибка остановки supervisor сохраняет каталоги для диагностики.
 */
export async function createGitSyncFixture(): Promise<GitSyncFixture> {
  await mkdir(artifacts, { recursive: true });
  const root = await mkdtemp(join(artifacts, "workflow-"));
  const workers = new Set<GitSyncReplica>();
  const supervisors = new Map<GitSyncReplica, GitSyncSupervisorProcess>();
  try {
    // Глубокий каталог артефактов не должен упираться в ограничение путей Git for Windows.
    await writeFile(join(root, ".gitconfig"), "[core]\n\tlongpaths = true\n");
    const a = await createReplica(root);
    const b = await createReplica(root);
    const remote = join(root, "shared remote.git");
    await createBareRemote(a, remote);
    return {
      root,
      remote,
      a,
      b,
      /**
       * Помечает worker как ресурс маршрута до потенциально неуспешного запуска.
       */
      ownWorker(replica: GitSyncReplica): void {
        workers.add(replica);
      },
      /**
       * Регистрирует владение foreground CLI до ожидания supervisor readiness.
       */
      async startSupervisor(replica: GitSyncReplica): Promise<void> {
        if (supervisors.has(replica)) {
          throw new Error("Supervisor этого HOME уже принадлежит fixture");
        }
        const supervisor = launchGitSyncSupervisor(replica);
        supervisors.set(replica, supervisor);
        await supervisor.ready();
      },
      /**
       * Завершает workers, затем supervisor/CLI и только после этого удаляет данные.
       */
      async close(): Promise<void> {
        const stopped = await Promise.allSettled([...workers].map(stopReplicaWorker));
        const supervisorsStopped = await Promise.allSettled(
          [...supervisors.values()].map((supervisor) => supervisor.close()),
        );
        const errors = [...stopped, ...supervisorsStopped].flatMap((result) =>
          result.status === "rejected" ? [result.reason] : [],
        );
        if (supervisorsStopped.some((result) => result.status === "rejected")) {
          throw new AggregateError(errors, "Ошибка остановки supervisor; fixture сохранён");
        }
        await Promise.all([a.close(), b.close()]);
        await rm(root, { recursive: true, force: true });
        if (errors.length > 0) {
          throw new AggregateError(errors, "Ошибка очистки Git Sync fixture");
        }
      },
    };
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}
