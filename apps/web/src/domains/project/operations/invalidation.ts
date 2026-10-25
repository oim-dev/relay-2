import type { ProjectScopeValue } from "../types/project.types";

const listeners = new Map<string, Set<() => void>>();

/**
 * Подписывает составной SWRInfinite-кеш на инвалидирование своего server/project.
 * Ключи страниц и внутренний $inf$-ключ SWR различны, поэтому используем API владельца списка.
 */
export function subscribeProjectInvalidation(
  scope: ProjectScopeValue,
  listener: () => void,
): () => void {
  const key = JSON.stringify([scope.serverKey, scope.projectId]);
  let subscriptions = listeners.get(key);
  if (!subscriptions) {
    subscriptions = new Set();
    listeners.set(key, subscriptions);
  }
  subscriptions.add(listener);
  return () => {
    subscriptions.delete(listener);
    if (subscriptions.size === 0) {
      listeners.delete(key);
    }
  };
}

/**
 * Обновляет только активные составные списки исходного проекта, не касаясь drafts.
 */
export function invalidateProjectPages(scope: ProjectScopeValue): void {
  const key = JSON.stringify([scope.serverKey, scope.projectId]);
  listeners.get(key)?.forEach((listener) => listener());
}
