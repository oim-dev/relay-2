import { z } from "zod";
import { relationDraftMessages } from "../config/relation-draft.messages";
import { readSessionStored, writeSessionStored, removeSessionStored } from "infra/browser-storage";
import type {
  RelationDraftSnapshot,
  RelationDraftLease,
  RelationRemovalDraft,
} from "../types/relation-draft.types";

const draftSchema = z.object({
  version: z.string(),
  values: z.object({ from: z.string(), to: z.string(), type: z.string(), description: z.string() }),
  uncertain: z.boolean(),
  error: z.string().nullable(),
});
const removalSchema = z.object({ root: z.string(), edgeId: z.string(), version: z.string() });
const owners = new Map<string, symbol>();

/**
 * Разделяет формы проекта и исходной связи; browser-storage добавляет origin.
 */
export function relationDraftKey(project: string, root: string | null): string {
  return JSON.stringify(["relation-editor", project, root]);
}

/**
 * Восстанавливает именно исходный generation; повреждение не подменяется новой пустой формой.
 */
export function readRelationDraft(
  key: string,
  root: string | null,
  version: string,
): RelationDraftSnapshot {
  const value = readSessionStored(key);
  return value === undefined
    ? {
        version,
        values: { from: root ?? "", to: "", type: "references", description: "" },
        uncertain: false,
        error: null,
      }
    : draftSchema.parse(value);
}

/**
 * Новый экземпляр отзывает старый, включая быстрый маршрут A → B → A.
 */
export function claimRelationDraft(key: string): RelationDraftLease {
  const identity = Symbol(key);
  owners.set(key, identity);
  return {
    /**
     * Разрешает публикацию только последнему активному владельцу.
     */
    isCurrent: () => owners.get(key) === identity,
    /**
     * Поздняя очистка старого экземпляра не отзывает новый.
     */
    dispose: () => {
      if (owners.get(key) === identity) {
        owners.delete(key);
      }
    },
  };
}

/**
 * Сохраняет снимок только от активного mount; JSON копируется инфраструктурой.
 */
export function saveRelationDraft(
  key: string,
  lease: RelationDraftLease,
  snapshot: RelationDraftSnapshot,
): boolean {
  if (!lease.isCurrent()) {
    return false;
  }
  if (!writeSessionStored(key, snapshot)) {
    throw new Error(relationDraftMessages.storage);
  }
  return true;
}

/**
 * Удаляет только подтверждённый draft действующего экземпляра.
 */
export function clearRelationDraft(key: string, lease: RelationDraftLease): boolean {
  if (!lease.isCurrent()) {
    return false;
  }
  removeSessionStored(key);
  return true;
}

/**
 * Читает подтверждение отзыва в выбранном проекте без подстановки свежей версии.
 */
export function readRelationRemoval(project: string): RelationRemovalDraft | null {
  const value = readSessionStored(JSON.stringify(["relation-removal", project]));
  return value === undefined ? null : removalSchema.parse(value);
}

/**
 * Сохраняет либо подтверждает завершение отзыва; scope guard проверяет screen-владелец.
 */
export function saveRelationRemoval(project: string, draft: RelationRemovalDraft | null): void {
  const key = JSON.stringify(["relation-removal", project]);
  if (draft === null) {
    removeSessionStored(key);
  } else if (!writeSessionStored(key, draft)) {
    throw new Error(relationDraftMessages.removalStorage);
  }
}
