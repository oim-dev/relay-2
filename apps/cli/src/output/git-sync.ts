import { gitSyncCommandMessages as messages } from "../locales/commands/git-sync";
import { isObject } from "./values";
import { outputMessages } from "../locales/output";

/**
 * Форматирует состояние без подмены неизвестных счётчиков нулём и без вывода о живости worker по sync.
 */
function statusValue(value: unknown, depth = 0): string {
  if (value === null || value === undefined) {
    return messages.unknown;
  }
  if (typeof value === "boolean") {
    return value ? outputMessages.yes : outputMessages.no;
  }
  if (Array.isArray(value)) {
    return value.length ? value.map((item) => statusValue(item, depth)).join("\n") : "[]";
  }
  if (!isObject(value)) {
    return String(value);
  }
  const labels: Readonly<Record<string, string>> = messages.statusLabels;
  return Object.entries(value)
    .map(([key, item]) => {
      const nested = isObject(item);
      return `${"  ".repeat(depth)}${labels[key] ?? key}:${nested ? "\n" : " "}${statusValue(item, nested ? depth + 1 : depth)}`;
    })
    .join("\n");
}

/**
 * Разделяет предметную наблюдаемость обмена и проверенную компонентом живость worker.
 */
function projectStatus(data: unknown): string {
  if (isObject(data) && isObject(data.worker)) {
    const { worker, ...sync } = data;
    return `${messages.syncHeading}:\n${statusValue(sync, 1)}\n\n${messages.workerHeading}:\n${statusValue(worker, 1)}`;
  }
  return statusValue(data);
}

/**
 * Представляет каждый workspace-исход самостоятельным блоком; JSON остаётся исходным объектом.
 */
export function renderGitSyncStatus(data: unknown): string {
  if (
    isObject(data) &&
    (data.scope === "workspace" || data.scope === "project") &&
    Array.isArray(data.items)
  ) {
    if (data.items.length === 0) {
      return messages.noProjects;
    }
    return data.items
      .map((item) => {
        if (!isObject(item)) {
          return statusValue(item);
        }
        const header = [item.name, item.path]
          .filter((value) => value !== null && value !== undefined)
          .join(" — ");
        return `${header ? `${header}\n` : ""}${projectStatus(item.ok === true ? item.data : { error: item.error })}`;
      })
      .join("\n\n");
  }
  return projectStatus(data);
}
