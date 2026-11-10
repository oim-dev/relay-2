import { expect } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  createWorkflowEnvironment,
  workflowArtifactsDirectory,
} from "../../../apps/cli/tests/e2e/helpers/workflow-fixture";
import type { GitSyncFixture, GitSyncReplica } from "./git-sync-fixture.types";

const artifacts = join(workflowArtifactsDirectory, "git-sync-implementation/e2e");

/**
 * Создаёт пустую копию проекта с отдельным HOME и Git-окружением; обмен встроен в CLI.
 */
async function createReplica(root: string): Promise<GitSyncReplica> {
  const environment = await createWorkflowEnvironment(root, {
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
 * Создаёт bare только как изолированный общий remote; никакие пользовательские настройки не читаются.
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
 * Выделяет два каталога и общий remote без скрытых init/connect/restore.
 * Каждый CLI-вызов владеет своим обменом; close ожидает процессы fixture до удаления файлов.
 */
export async function createGitSyncFixture(): Promise<GitSyncFixture> {
  await mkdir(artifacts, { recursive: true });
  const root = await mkdtemp(join(artifacts, "workflow-"));
  try {
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
       * Закрывает оба процессных окружения, затем удаляет изолированные данные.
       */
      async close(): Promise<void> {
        await Promise.all([a.close(), b.close()]);
        await rm(root, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}
