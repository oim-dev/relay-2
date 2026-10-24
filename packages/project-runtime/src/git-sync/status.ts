import { resolve } from "node:path";
import { RelayError } from "@relay/contracts";
import { readConfig } from "../configuration/config";
import {
  explicitConfig,
  findConfig,
  projectConfigName,
  validateOptions,
} from "../configuration/paths";
import type { RuntimeOptions } from "../configuration/runtime-options.types";
import { listProjects } from "../workspace/registry";
import type { GitSyncClient } from "./client.types";
import { gitSyncMessages as messages } from "./git-sync.messages";
import type { GitSyncWorkspaceItem, GitSyncWorkspaceStatus } from "./status.types";

/**
 * Определяет workspace без обращения к конфигам/БД его регистраций и без обхода родительских каталогов.
 */
export function isGitSyncWorkspace(options: RuntimeOptions): boolean {
  validateOptions(options);
  const path = explicitConfig(options) ?? findConfig(options.cwd, false);
  return path !== undefined && "projects" in readConfig(path);
}

/**
 * Читает статус каждой регистрации независимо; повреждение одного проекта не скрывает остальные.
 * Последовательные запросы ограничивают число дочерних процессов и сохраняют порядок реестра.
 */
export async function readGitSyncWorkspaceStatus(
  client: GitSyncClient,
  options: RuntimeOptions,
  refresh: boolean,
): Promise<GitSyncWorkspaceStatus> {
  if (options.project !== undefined) {
    throw new RelayError("INVALID_ARGUMENT", messages.allAndProject, 2);
  }
  const registrations = listProjects(options);
  const items: GitSyncWorkspaceItem[] = [];
  for (const registration of registrations) {
    try {
      const data = await client.request({
        version: 1,
        action: "status",
        options: {
          cwd: options.cwd,
          config: resolve(registration.path, projectConfigName),
          ...(options.home !== undefined ? { home: options.home } : {}),
        },
        input: { refresh },
      });
      items.push({ ...registration, ok: true, data });
    } catch (error) {
      const failure =
        error instanceof RelayError
          ? error
          : new RelayError(
              "INTERNAL_ERROR",
              error instanceof Error ? error.message : String(error),
            );
      items.push({
        ...registration,
        ok: false,
        error: {
          code: failure.code,
          message: failure.message,
          exitCode: failure.exitCode,
          ...(failure.details ? { details: failure.details } : {}),
        },
      });
    }
  }
  return { version: 1, scope: "workspace", items };
}
