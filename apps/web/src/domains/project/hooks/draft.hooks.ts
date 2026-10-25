import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import { useProject } from "../project-context";
import type { DraftState } from "../types/project.types";

const drafts = new Map<string, unknown>();
const listeners = new Set<() => void>();

/**
 * Подписывает React на собственные черновики вкладки.
 */
function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Сохраняет пользовательский ввод вне GET-кеша, с независимым ключом server/project/name.
 * Поздний callback размонтированного экрана не меняет новый экземпляр A → B → A.
 */
export function useDraft<T>(name: string, initial: T): DraftState<T> {
  const scope = useProject();
  const key = JSON.stringify([scope.serverKey, scope.projectId, name]);
  // Идентичность черновика задаёт name, а вход initial после первого чтения — уже серверное обновление.
  const owner = useMemo(() => ({ initial, active: true }), [key]);
  useEffect(() => {
    owner.active = true;
    if (!drafts.has(key)) {
      drafts.set(key, owner.initial);
      listeners.forEach((listener) => listener());
    }
    return () => {
      owner.active = false;
    };
  }, [key, owner]);
  const snapshot = useCallback((): T => {
    // Запись по ключу создаётся и читается одним типизированным владельцем формы.
    return drafts.has(key) ? (drafts.get(key) as T) : owner.initial;
  }, [key, owner]);
  const value = useSyncExternalStore(subscribe, snapshot);
  return {
    value,
    setValue: (next) => {
      if (!owner.active) {
        return;
      }
      drafts.set(key, next);
      listeners.forEach((listener) => listener());
    },
    reset: () => {
      if (!owner.active) {
        return;
      }
      drafts.delete(key);
      listeners.forEach((listener) => listener());
    },
  };
}
