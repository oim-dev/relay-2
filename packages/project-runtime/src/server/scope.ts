import { realpathSync, statSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { RelayError } from "@relay/contracts";
import { readConfig } from "../configuration/config";
import {
  explicitConfig,
  findConfig,
  projectConfigName,
  validateOptions,
} from "../configuration/paths";
import type { RuntimeOptions } from "../configuration/runtime-options.types";
import { openProject } from "../project/selection";
import { serverMessages as messages } from "./server.messages";
import type { ResolvedServerScope, ServerProjectLocation } from "./server.types";

/**
 * Читает одну регистрацию независимо, закрывая проверочное соединение при любом исходе.
 */
function projectStatus(
  options: RuntimeOptions,
  name: string,
  path: string,
  mode: "single" | "workspace",
): ServerProjectLocation {
  try {
    const { location, database } = openProject(options);
    try {
      const file = realpathSync(location.databasePath);
      const stat = statSync(file, { bigint: true });
      const project = database.get(location.projectId);
      if (
        !project ||
        typeof project.data.name !== "string" ||
        typeof project.data.slug !== "string" ||
        stat.ino <= 0n
      ) {
        throw new RelayError("INVALID_PROJECT", messages.invalid, 4);
      }
      return {
        id: location.projectId,
        name: name || project.data.name,
        slug: project.data.slug,
        path: dirname(realpathSync(location.configPath)),
        available: true,
        location: { ...location, databasePath: file },
        identity: `${stat.dev}:${stat.ino}:${stat.birthtimeNs}`,
      };
    } finally {
      database.close();
    }
  } catch (cause) {
    if (mode === "single") {
      throw cause;
    }
    return {
      id: null,
      name: name || basename(path),
      slug: null,
      path,
      available: false,
      location: null,
      identity: null,
      error: {
        code: cause instanceof RelayError ? cause.code : "PROJECT_UNAVAILABLE",
        message: cause instanceof Error ? cause.message : String(cause),
      },
    };
  }
}

/**
 * Разрешает project/workspace по общим правилам Runtime, сохраняя ошибки отдельных регистраций.
 * Повтор физической БД допустим; одинаковый ID разных файлов отклоняется целиком до обслуживания HTTP.
 * Соединения открываются последовательно и закрываются; результат не удерживает snapshot/файлы.
 */
export function resolveServerScope(options: RuntimeOptions): ResolvedServerScope {
  validateOptions(options);
  const selected =
    explicitConfig(options) ?? findConfig(options.cwd, options.project !== undefined);
  if (!selected) {
    throw new RelayError("PROJECT_NOT_FOUND", messages.noConfig, 3);
  }
  const config = readConfig(selected);
  const configPath = realpathSync(selected);
  const workspace = "projects" in config && options.project === undefined;
  const projects = workspace
    ? config.projects.map((entry) =>
        projectStatus(
          {
            cwd: options.cwd,
            config: resolve(entry.path, projectConfigName),
            ...(options.home !== undefined ? { home: options.home } : {}),
          },
          entry.name,
          entry.path,
          "workspace",
        ),
      )
    : [projectStatus(options, options.project ?? "", dirname(configPath), "single")];
  const identities = new Map<string, string>();
  for (const project of projects) {
    if (project.id && project.identity) {
      const previous = identities.get(project.id);
      if (previous && previous !== project.identity) {
        throw new RelayError("SERVER_PROJECT_AMBIGUOUS", messages.ambiguousProject, 4, {
          projectId: project.id,
        });
      }
      identities.set(project.id, project.identity);
    }
  }
  return {
    scope: {
      kind: workspace ? "workspace" : "project",
      configPath,
      project: options.project ?? null,
    },
    projects,
  };
}
