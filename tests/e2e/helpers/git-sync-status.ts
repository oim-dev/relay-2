import type { GitSyncStatusResult } from "./git-sync-status.types";

/**
 * Проверяет объектную форму внешнего JSON, сохраняя неизвестность значений его полей.
 */
function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Декодирует существенные поля исходного статуса компонента, возвращаемого auto/worker.
 * Ожидаемые режим, живость, instance, конфликты и остановку проверяет сам маршрут.
 */
export function readGitSyncStatus(value: unknown): GitSyncStatusResult {
  if (!isObject(value) || !isObject(value.worker) || !isObject(value.conflicts)) {
    throw new Error("Ожидался статус Git Sync с worker и conflicts");
  }
  const { mode, worker, conflicts, nextRetry } = value;
  if (
    (mode !== "manual" && mode !== "auto") ||
    (worker.desired !== "running" && worker.desired !== "stopped") ||
    (worker.actual !== "running" && worker.actual !== "stopped" && worker.actual !== "unknown") ||
    typeof worker.responsive !== "boolean" ||
    (worker.instance !== null &&
      (typeof worker.instance !== "string" || worker.instance.length === 0)) ||
    typeof conflicts.count !== "number" ||
    !Number.isSafeInteger(conflicts.count) ||
    conflicts.count < 0 ||
    (nextRetry !== null && (typeof nextRetry !== "string" || nextRetry.length === 0))
  ) {
    throw new Error(
      "Статус Git Sync должен содержать корректные mode, worker, conflicts.count и nextRetry",
    );
  }
  return {
    mode,
    worker: {
      desired: worker.desired,
      actual: worker.actual,
      responsive: worker.responsive,
      instance: worker.instance,
    },
    conflicts: { count: conflicts.count },
    nextRetry,
  };
}

/**
 * Извлекает единственный успешный статус из публичной оболочки status после invokeSuccess.
 * Общая форма project/workspace требует version: 1 и ровно один элемент items в этом маршруте.
 */
export function readSingleGitSyncStatus(value: unknown): GitSyncStatusResult {
  if (
    !isObject(value) ||
    value.version !== 1 ||
    (value.scope !== "project" && value.scope !== "workspace") ||
    !Array.isArray(value.items) ||
    value.items.length !== 1
  ) {
    throw new Error("Ожидалась публичная оболочка Git Sync с единственным элементом items");
  }
  const item: unknown = value.items[0];
  if (!isObject(item) || item.ok !== true) {
    throw new Error("Единственный проект должен вернуть успешный статус");
  }
  return readGitSyncStatus(item.data);
}
