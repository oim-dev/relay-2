import { RelayError } from "@relay/contracts";
import { basename, dirname, join, resolve } from "node:path";
import { mkdirSync, realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import { withLocalFileLock } from "@relay/storage";
import { resolveRelayHome } from "../configuration/home";
import { readConfig, validText } from "../configuration/config";
import { fileExists, withFileErrors } from "../configuration/files";
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
import type { ProjectRestorationContext, RestorationTarget } from "./restoration.types";
import { selectProjectConfig } from "./selection";
import { physicalConfigPath } from "../native/config-path/select";
import type { SelectedProjectConfig } from "./selection.types";

/**
 * Выбирает существующий проект по общим правилам; null разрешён только для свободной новой привязки.
 */
function restorationConfig(options: RuntimeOptions): SelectedProjectConfig | null {
  validateOptions(options);
  const candidate =
    explicitConfig(options) ?? findConfig(options.cwd, options.project !== undefined);
  if (!candidate || !fileExists(candidate)) {
    return null;
  }
  const selected = selectProjectConfig(options);
  validateRestorationProjectId(selected.config.projectId);
  return selected;
}

/**
 * Сохраняет выбранный alias config по контракту ProjectLocation; проверяет только расположение, не SQLite.
 */
function restorationLocation(
  selected: SelectedProjectConfig,
  options: RuntimeOptions,
): ProjectLocation {
  return {
    configPath: selected.configPath,
    projectId: selected.config.projectId,
    databasePath:
      selected.config.databasePath ??
      defaultProjectDatabasePath(options, selected.config.projectId),
  };
}

/**
 * Разрешает физический путь будущей SQLite через существующего предка без создания файлов.
 */
function physicalDatabasePath(path: string): string {
  const missing: string[] = [];
  let current = resolve(path);
  while (!fileExists(current) && dirname(current) !== current) {
    missing.unshift(basename(current));
    current = dirname(current);
  }
  return join(realpathSync(current), ...missing);
}

/**
 * Выбирает актуальную привязку restore без открытия SQLite, включая утрату БД и новый проект.
 * Некорректный выбор workspace/конфига не превращается в новый проект; физический root не берётся из cache Git Sync.
 */
export function resolveProjectRestoration(options: RuntimeOptions): ProjectRestorationContext {
  return withFileErrors(() => {
    const selected = restorationConfig(options);
    if (selected !== null) {
      const location = restorationLocation(selected, options);
      return {
        configPath: physicalConfigPath(location.configPath),
        projectId: location.projectId,
        databasePath: physicalDatabasePath(location.databasePath),
      };
    }
    const path = initializationPath(options, false);
    return {
      configPath: physicalDatabasePath(path),
      databasePath: null,
      projectId: null,
    };
  });
}

/**
 * Сериализует публикации одного физического config даже до получения постоянного ID.
 * Mutex находится в home, а не в checkout; после входа вызывающий заново выбирает цель.
 * Блокировка удерживается на всём синхронном сценарии и не удаляется после освобождения.
 * Порядок захвата — config, затем каталог БД; async callback запрещён механизмом Storage.
 */
export function withRestorationConfigurationLock(
  options: RuntimeOptions,
  operation: () => ProjectLocation,
): ProjectLocation {
  const selected = resolveProjectRestoration(options);
  const key = createHash("sha256").update(selected.configPath).digest("hex");
  const directory = join(resolveRelayHome(options), ".restore", key);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  return withLocalFileLock(join(directory, "configuration"), operation);
}

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
  if (projectId !== undefined) {
    validateRestorationProjectId(projectId);
  }
  const selected = restorationConfig(options);
  if (selected !== null) {
    if (projectId !== undefined && selected.config.projectId !== projectId) {
      throw new RelayError(
        "PROJECT_ID_MISMATCH",
        projectMessages.projectIdMismatch(selected.configPath),
        4,
      );
    }
    return {
      existingConfig: true,
      location: restorationLocation(selected, options),
    };
  }
  if (projectId === undefined) {
    throw new RelayError("RESTORE_PROJECT_ID_REQUIRED", restorationMessages.projectIdRequired, 2);
  }
  const configPath = initializationPath(options, false);
  return {
    existingConfig: false,
    location: {
      configPath,
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
