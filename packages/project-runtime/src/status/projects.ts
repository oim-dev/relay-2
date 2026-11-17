import { readdirSync } from "node:fs";
import { join } from "node:path";
import { RelayError } from "@relay/contracts";
import { ProjectDatabase } from "@relay/storage";
import { hasCode } from "../configuration/files";
import { statusError, statusPath } from "./files";
import { statusMessages as messages } from "./status.messages";
import type {
  RelayConfigurationStatus,
  RelayProjectStatus,
  StatusProjectCandidate,
} from "./status.types";

/**
 * Перечисляет стандартные хранилища и явно известные overrides. Отсутствующий home не создаётся.
 * Каталог без БД остаётся кандидатом с диагностикой; поломка одной БД не скрывает остальные.
 */
function candidates(
  home: string,
  configurations: readonly RelayConfigurationStatus[],
): readonly StatusProjectCandidate[] {
  const found = new Map<string, StatusProjectCandidate>();
  /**
   * Объединяет один ID/файл, сохраняя все известные конфиги и несовпадающие базы отдельно.
   */
  function add(projectId: string, databasePath: string, configPath?: string): void {
    let path = databasePath;
    let error;
    try {
      path = statusPath(databasePath);
    } catch (cause) {
      error = statusError(cause);
    }
    const key = JSON.stringify([projectId, path]);
    let value = found.get(key);
    if (!value) {
      value = {
        projectId,
        databasePath: path,
        configPaths: [],
        ...(error === undefined ? {} : { error }),
      };
      found.set(key, value);
    }
    if (configPath !== undefined && !value.configPaths.includes(configPath)) {
      value.configPaths.push(configPath);
    }
  }
  try {
    for (const entry of readdirSync(join(home, "projects"), { withFileTypes: true })) {
      if (entry.isDirectory() || entry.isSymbolicLink()) {
        add(entry.name, join(home, "projects", entry.name, "project.sqlite"));
      }
    }
  } catch (error) {
    if (!hasCode(error, "ENOENT")) {
      throw error;
    }
  }
  for (const config of configurations) {
    if (config.projectId !== null && config.databasePath !== null) {
      add(config.projectId, config.databasePath, config.path);
    }
  }
  return [...found.values()].sort(
    (a, b) =>
      a.projectId.localeCompare(b.projectId) || a.databasePath.localeCompare(b.databasePath),
  );
}

/**
 * Открывает только readonly-соединение и читает имя/расписание одного проекта в snapshot.
 * Предметные карточки, outbox и Git не сканируются; миграции явно запрещены этим режимом Storage.
 */
function inspect(
  candidate: StatusProjectCandidate,
  currentConfig: string | null,
): RelayProjectStatus {
  const base = {
    ...candidate,
    current: currentConfig !== null && candidate.configPaths.includes(currentConfig),
  };
  if (candidate.error !== undefined) {
    return { ...base, name: null, available: false, synchronization: null };
  }
  try {
    const db = ProjectDatabase.openReadonly(candidate.databasePath);
    try {
      if (db.projectId !== candidate.projectId) {
        throw new RelayError("PROJECT_ID_MISMATCH", messages.mismatch, 4);
      }
      return db.snapshot(() => {
        const project = db.getManySummaries([db.projectId])[0];
        if (project?.kind !== "project" || typeof project.title !== "string") {
          throw new RelayError("INVALID_PROJECT", messages.invalidProject, 4);
        }
        return {
          ...base,
          databasePath: statusPath(candidate.databasePath),
          name: project.title,
          available: true,
          synchronization: db.getSynchronizationSchedule().mode,
        };
      });
    } finally {
      db.close();
    }
  } catch (error) {
    return {
      ...base,
      name: null,
      available: false,
      synchronization: null,
      error: statusError(error),
    };
  }
}

/**
 * Получает независимые наблюдения всех известных БД home; одновременно открыто не более одного соединения.
 */
export function readStatusProjects(
  home: string,
  configurations: readonly RelayConfigurationStatus[],
  currentConfig: string | null,
): readonly RelayProjectStatus[] {
  return candidates(home, configurations).map((candidate) => inspect(candidate, currentConfig));
}
