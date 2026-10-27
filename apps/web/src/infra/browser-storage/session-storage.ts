import { createTabStorage } from "./tab-storage";
import type { SessionReadResult } from "./storage.types";

const drafts = createTabStorage();

/**
 * Читает draft текущей вкладки; проверку предметной схемы выполняет владелец формы.
 */
export function readSessionStored(key: string): unknown {
  return drafts.read(key).value;
}

/**
 * Сохраняет прежний контракт формы без чтения старых sessionStorage drafts.
 */
export function readSessionValue(key: string): SessionReadResult {
  return drafts.read(key);
}

/**
 * Сохраняет JSON-снимок в памяти вкладки без зависимости от browser storage permissions.
 */
export function writeSessionStored(key: string, snapshot: unknown): boolean {
  return drafts.write(key, snapshot);
}

/**
 * Удаляет явно отменённый или успешно сохранённый draft текущего origin.
 */
export function removeSessionStored(key: string): void {
  drafts.remove(key);
}
