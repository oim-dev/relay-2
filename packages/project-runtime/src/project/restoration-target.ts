import { RelayError } from "@relay/contracts";
import { readConfig, validText } from "../configuration/config";
import { fileExists } from "../configuration/files";
import {
  explicitConfig,
  findConfig,
  initializationPath,
  validateOptions,
} from "../configuration/paths";
import type { RuntimeOptions } from "../configuration/runtime-options.types";
import { defaultProjectDatabasePath } from "./database-path";
import type { ProjectLocation } from "./location.types";
import { projectMessages } from "./project.messages";
import { restorationMessages } from "./restoration.messages";
import type { RestorationTarget } from "./restoration.types";
import { selectProjectConfig } from "./selection";

/**
 * Требует один постоянный ID, пригодный для стандартного каталога БД, без компонентов пути.
 */
export function validateRestorationProjectId(projectId: string): void {
  if (
    !validText(projectId) ||
    projectId === "." ||
    projectId === ".." ||
    /[/\\]/u.test(projectId)
  ) {
    throw new RelayError("INVALID_ARGUMENT", projectMessages.restoreInvalidId, 2);
  }
}

/**
 * Выбирает точную цель по существующему config или явному ID, не открывая БД и не сканируя home.
 * Явный ID должен совпадать с config; отсутствие обоих источников — ошибка до создания файлов.
 */
export function selectRestorationTarget(
  options: RuntimeOptions,
  projectId?: string,
): RestorationTarget {
  validateOptions(options);
  if (projectId !== undefined) {
    validateRestorationProjectId(projectId);
  }
  const candidate =
    explicitConfig(options) ?? findConfig(options.cwd, options.project !== undefined);
  if (candidate && fileExists(candidate)) {
    const { configPath, config } = selectProjectConfig(options);
    if (projectId !== undefined && config.projectId !== projectId) {
      throw new RelayError("PROJECT_ID_MISMATCH", projectMessages.projectIdMismatch(configPath), 4);
    }
    validateRestorationProjectId(config.projectId);
    return {
      existingConfig: true,
      location: {
        configPath,
        projectId: config.projectId,
        databasePath: config.databasePath ?? defaultProjectDatabasePath(options, config.projectId),
      },
    };
  }
  if (projectId === undefined) {
    throw new RelayError("RESTORE_PROJECT_ID_REQUIRED", restorationMessages.projectIdRequired, 2);
  }
  return {
    existingConfig: false,
    location: {
      configPath: initializationPath(options, false),
      projectId,
      databasePath: defaultProjectDatabasePath(options, projectId),
    },
  };
}

/**
 * Повторно сверяет существующий config перед привязкой; его содержание и формат не переписываются.
 */
export function requireMatchingRestorationConfig(
  location: ProjectLocation,
  options: RuntimeOptions,
): void {
  const current = readConfig(location.configPath);
  if (
    !("projectId" in current) ||
    current.projectId !== location.projectId ||
    (current.databasePath ?? defaultProjectDatabasePath(options, current.projectId)) !==
      location.databasePath
  ) {
    throw new RelayError(
      "PROJECT_ID_MISMATCH",
      projectMessages.projectIdMismatch(location.configPath),
      4,
    );
  }
}
