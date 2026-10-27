import { currentNativePlatform } from "@relay/project-runtime";
import { ownerChildren, processIdentity } from "./linux/owner-observation";
import type { ProcessIdentity } from "../guardian-helpers/owner-observation.types";

/**
 * Возвращает procfs-идентичность только при поддержке этого наблюдения платформой.
 * null означает недоступную характеристику, не отсутствие или завершение процесса.
 */
export function nativeProcessIdentity(pid: number): ProcessIdentity | null {
  return currentNativePlatform() === "linux" ? processIdentity(pid) : null;
}

/**
 * Читает bounded список детей Linux owner; другие ОС не предоставляют эту дополнительную диагностику.
 * Пустой список не подтверждает успешную очистку дерева.
 */
export function nativeOwnerChildren(pid: number): readonly number[] {
  return currentNativePlatform() === "linux" ? ownerChildren(pid) : [];
}
