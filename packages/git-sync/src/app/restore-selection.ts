import { createHash } from "node:crypto";
import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { RelayError, type GitSyncRequest } from "@relay/contracts";
import {
  resolveProjectRestoration,
  resolveVacantRestorationTarget,
  type ProjectLocation,
  type ProjectRestorationContext,
  type RuntimeOptions,
} from "@relay/project-runtime";
import { homeDirectory, readConfiguration, stateDirectory } from "../local/state";
import type { SyncConfiguration } from "../local/state.types";
import { DEFAULT_DATA_BRANCH } from "../local/state.constants";
import { absoluteRemote, validateBranch } from "../transport/git";
import { transportMessages } from "../transport/transport.messages";
import { requireGitExecutionActive } from "../execution/context";
import { appMessages } from "./app.messages";
import { requiredString } from "./protocol";
import { projectOrigin } from "./project-connection";
import { connectionMessages } from "./project-connection.messages";
import type { RestorationSource } from "./restore.types";

/**
 * Проверяет saved identity до использования remote; старые абсолютные пути заменяются текущим выбором.
 * Без config/ID не сканирует home и не пытается угадать подключение будущей реплики.
 */
function restorationConnection(selected: ProjectRestorationContext): SyncConfiguration | null {
  if (selected.databasePath === null) {
    return null;
  }
  const saved = readConfiguration(stateDirectory(selected.databasePath));
  if (saved === null) {
    return null;
  }
  if (
    (selected.projectId !== null && saved.projectId !== selected.projectId) ||
    (saved.databasePath !== selected.databasePath && existsSync(saved.databasePath))
  ) {
    throw new RelayError("GIT_REPLICA_MISMATCH", appMessages.projectChanged, 4);
  }
  return { ...saved, configPath: selected.configPath, databasePath: selected.databasePath };
}

/**
 * Фиксирует источник и каталог owner без создания файлов и открытия утраченной SQLite.
 * До fetch нового проекта ID неизвестен: подготовка сериализуется по физическому config в home.
 * Несовпадение сохранённого адресата и отсутствие необходимого origin дают отказ до сети.
 */
export async function selectRestorationSource(request: GitSyncRequest): Promise<RestorationSource> {
  const input = request.input ?? {};
  const selected = resolveProjectRestoration(request.options);
  const root = dirname(selected.configPath);
  const key = createHash("sha256").update(selected.configPath).digest("hex");
  const preparationDirectory =
    selected.databasePath === null
      ? join(homeDirectory(request.options), ".restore", key)
      : stateDirectory(selected.databasePath);
  const saved = restorationConnection(selected);
  const inherited =
    input.remote === undefined
      ? saved?.remoteName !== undefined || saved === null
      : input.remote === "origin";
  const liveOrigin = inherited ? await projectOrigin(root) : null;
  if (
    inherited &&
    liveOrigin === null &&
    (input.remote === "origin" || saved?.remoteName !== undefined)
  ) {
    throw new RelayError("GIT_REMOTE_NOT_CONFIGURED", connectionMessages.missing, 4);
  }
  const remote =
    liveOrigin ??
    (input.remote === undefined
      ? saved?.remote
      : await absoluteRemote(root, requiredString(input.remote)));
  if (remote === undefined || remote === null) {
    throw new RelayError("INVALID_ARGUMENT", appMessages.remoteRequired, 2);
  }
  const branch =
    input.branch === undefined
      ? (saved?.branch ?? DEFAULT_DATA_BRANCH)
      : requiredString(input.branch);
  if (saved && (saved.remote !== remote || saved.branch !== branch)) {
    throw new RelayError("GIT_ORIGIN_MISMATCH", transportMessages.originMismatch, 4);
  }
  await validateBranch(request.options.cwd, branch);
  return { selected, root, preparationDirectory, saved, remote, branch, inherited };
}

/**
 * После await проверяет активность обращения и выбранную цель до следующей подготовки или публикации.
 * Отмена не публикует новую SQLite, а смена привязки не переключает проект во время восстановления.
 */
export function requireRestorationSelection(
  options: RuntimeOptions,
  selected: ProjectRestorationContext,
): void {
  requireGitExecutionActive();
  const current = resolveProjectRestoration(options);
  if (
    current.configPath !== selected.configPath ||
    current.databasePath !== selected.databasePath ||
    current.projectId !== selected.projectId
  ) {
    throw new RelayError("PROJECT_CHANGED", appMessages.projectChanged, 4);
  }
}

/**
 * После fetch выбирает свободную цель проверенного ID и физический путь для transport mutex.
 * Создаёт только родительский каталог БД; SQLite/config здесь не публикуются.
 * После получения owner вызывающий повторяет vacancy и guards исходного выбора.
 */
export function restorationTransportLocation(
  options: RuntimeOptions,
  projectId: string,
  configPath: string,
): ProjectLocation {
  const target = resolveVacantRestorationTarget(options, projectId);
  mkdirSync(dirname(target.databasePath), { recursive: true, mode: 0o700 });
  return {
    ...target,
    configPath,
    databasePath: join(realpathSync(dirname(target.databasePath)), basename(target.databasePath)),
  };
}
