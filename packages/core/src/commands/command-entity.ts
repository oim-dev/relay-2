import { isDeepStrictEqual } from "node:util";
import {
  validateActor,
  type CommandEffect,
  type EntityKind,
  type EntityRecord,
  type WriteOptions,
} from "@relay/contracts";
import {
  validateEntityAddress,
  validateEntityData,
  validateEntityWrite,
} from "../entities/entity-validation";
import type { CommandEntityAllocation } from "./command-context.types";

/**
 * Создаёт чистое содержание новой записи с уже выделенными ID, ключом и временем.
 */
export function createCommandEntity(
  kind: EntityKind,
  key: string,
  data: Readonly<Record<string, unknown>>,
  allocation: CommandEntityAllocation,
): EntityRecord {
  validateActor(allocation.actor);
  validateEntityAddress(key, "key");
  validateEntityData(data);
  return {
    id: allocation.id,
    kind,
    key,
    revision: 1,
    createdAt: allocation.timestamp,
    updatedAt: allocation.timestamp,
    createdBy: allocation.actor,
    updatedBy: allocation.actor,
    data: structuredClone(data),
  };
}

/**
 * Проверяет исходный CAS до no-op и рассчитывает изменение без I/O и чтения часов.
 * Независимый журнал задачи никогда не заменяется содержанием переданного patch.
 */
export function changeCommandEntity(
  current: Readonly<EntityRecord>,
  patch: Readonly<Record<string, unknown>>,
  write: Readonly<WriteOptions>,
  timestamp: string,
  key = current.key,
): EntityRecord {
  validateEntityWrite(current, write);
  validateEntityData(patch);
  validateEntityAddress(key, "key");
  const data = { ...current.data, ...structuredClone(patch) };
  if (current.kind === "task") {
    data.comments = current.data.comments;
  }
  if (key === current.key && isDeepStrictEqual(data, current.data)) {
    return structuredClone(current);
  }
  return {
    ...current,
    data,
    key,
    revision: current.revision + 1,
    updatedAt: timestamp,
    updatedBy: write.actor,
  };
}

/**
 * Представляет рассчитанную запись точным эффектом; no-op не создаёт фиктивной версии.
 */
export function entityCommandEffect(
  before: Readonly<EntityRecord> | null,
  after: Readonly<EntityRecord>,
): readonly CommandEffect[] {
  if (before !== null && isDeepStrictEqual(before, after)) {
    return [];
  }
  return [
    {
      kind: "entity",
      before: before === null ? null : structuredClone(before),
      after: structuredClone(after),
    },
  ];
}
