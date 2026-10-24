import { RelayError, type PortableEntity } from "@relay/contracts";
import { canonicalJson, portableEntity } from "@relay/storage";
import { mergeText } from "../sync-merge/text";
import { mergeOrder } from "../sync-merge/order";
import { replicationMessages } from "./replication.messages";
import type { ReplicationRecordOverride } from "./replication-resolution.types";

const markdownFields = new Set([
  "body",
  "description",
  "summary",
  "goal",
  "rationale",
  "boundaries",
  "expectedResult",
  "outcome",
  "completionConditions",
  "result",
]);
const collectionFields = new Set([
  "acceptanceCriteria",
  "stages",
  "relations",
  "runs",
  "documentSections",
  "retiredDocumentSectionIds",
  "dependencies",
  "related",
  "targets",
  "taskIds",
  "planIds",
  "implementationIds",
  "scope",
  "participants",
]);

/**
 * Отличает JSON-объект для внутреннего объединения уже проверенных предметных карточек.
 */
export function mergeObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Выбирает стабильную идентичность элемента известной предметной коллекции.
 */
function itemId(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (mergeObject(value)) {
    if (typeof value.id === "string") {
      return value.id;
    }
    if (
      mergeObject(value.target) &&
      typeof value.target.id === "string" &&
      typeof value.type === "string"
    ) {
      return `${value.target.id}:${value.type}`;
    }
  }
  throw new RelayError("REPLICATION_CONFLICT", replicationMessages.conflict, 4);
}

/**
 * Объединяет элементы по постоянным ID: снятие относительно base не воскрешается другой ветвью.
 * Удаление против правки и несовместимые перестановки остаются конфликтами.
 */
function mergeCollection(
  base: readonly unknown[],
  local: readonly unknown[],
  remote: readonly unknown[],
  field: string,
  preferLocal: boolean,
): unknown[] {
  const before = new Map(base.map((item) => [itemId(item), item]));
  const left = new Map(local.map((item) => [itemId(item), item]));
  const right = new Map(remote.map((item) => [itemId(item), item]));
  const merged = new Map<string, unknown>();
  for (const id of new Set([...before.keys(), ...left.keys(), ...right.keys()])) {
    const value = mergeValue(before.get(id), left.get(id), right.get(id), field, preferLocal);
    if (value !== undefined) {
      merged.set(id, value);
    }
  }
  const order = mergeOrder(
    [...before.keys()],
    [...left.keys()],
    [...right.keys()],
    [...merged.keys()],
  );
  if (!order.ok) {
    throw new RelayError("REPLICATION_CONFLICT", replicationMessages.conflict, 4, { field });
  }
  return order.items.map((id) => merged.get(id));
}

/**
 * Объединяет отдельные поля проверенного предметного состояния; не является публичной мутацией.
 */
export function mergeValue(
  base: unknown,
  local: unknown,
  remote: unknown,
  field: string,
  preferLocal: boolean,
): unknown {
  if (sameValue(local, remote) || sameValue(remote, base)) {
    return local;
  }
  if (sameValue(local, base)) {
    return remote;
  }
  if (mergeObject(base) && mergeObject(local) && mergeObject(remote)) {
    const result: Record<string, unknown> = {};
    for (const key of new Set([
      ...Object.keys(base),
      ...Object.keys(local),
      ...Object.keys(remote),
    ])) {
      const value = mergeValue(base[key], local[key], remote[key], key, preferLocal);
      if (value !== undefined) {
        result[key] = value;
      }
    }
    return result;
  }
  try {
    if (
      typeof base === "string" &&
      typeof local === "string" &&
      typeof remote === "string" &&
      markdownFields.has(field)
    ) {
      const merged = mergeText(base, local, remote);
      if (merged.ok) {
        return merged.text;
      }
      throw new RelayError("REPLICATION_CONFLICT", replicationMessages.conflict, 4, { field });
    }
    if (
      Array.isArray(base) &&
      Array.isArray(local) &&
      Array.isArray(remote) &&
      collectionFields.has(field)
    ) {
      return mergeCollection(base, local, remote, field, preferLocal);
    }
  } catch (error) {
    if (!preferLocal) {
      throw error;
    }
  }
  if (preferLocal) {
    return local;
  }
  throw new RelayError("REPLICATION_CONFLICT", replicationMessages.conflict, 4, { field });
}

/**
 * Сравнивает JSON-значения, сохраняя различие отсутствующего свойства и явного null.
 */
function sameValue(left: unknown, right: unknown): boolean {
  return left === undefined || right === undefined
    ? left === right
    : canonicalJson(left) === canonicalJson(right);
}

/**
 * Выполняет трёхстороннее объединение карточки без сравнения revision или часов для победы.
 * Конкурентное закрытие/владение требует явного решения; checkpoints никогда не переписываются.
 */
export function mergeRecord(
  base: PortableEntity | null,
  local: PortableEntity | null,
  remote: PortableEntity | null,
  preferLocal = false,
  override?: ReplicationRecordOverride,
): PortableEntity | null {
  if (override !== undefined) {
    return mergeDocumentText(base, local, remote, override);
  }
  if (local?.version === remote?.version || remote?.version === base?.version) {
    return local;
  }
  if (local?.version === base?.version) {
    return remote;
  }
  if (base === null || local === null || remote === null) {
    if (preferLocal) {
      return local;
    }
    throw new RelayError("REPLICATION_CONFLICT", replicationMessages.conflict, 4);
  }
  if (base.record.kind === "work-checkpoint") {
    throw new RelayError("REPLICATION_IMMUTABLE", replicationMessages.immutable, 4);
  }
  const data = mergeValue(
    base.record.data,
    local.record.data,
    remote.record.data,
    "data",
    preferLocal,
  );
  if (!mergeObject(data)) {
    throw new RelayError("REPLICATION_CONFLICT", replicationMessages.conflict, 4);
  }
  const key = mergeValue(base.record.key, local.record.key, remote.record.key, "key", preferLocal);
  if (typeof key !== "string") {
    throw new RelayError("REPLICATION_CONFLICT", replicationMessages.conflict, 4);
  }
  const localMetadataChanged =
    local.record.updatedAt !== base.record.updatedAt ||
    local.record.updatedBy !== base.record.updatedBy;
  const remoteMetadataChanged =
    remote.record.updatedAt !== base.record.updatedAt ||
    remote.record.updatedBy !== base.record.updatedBy;
  // Изменение единственной стороны сохраняется; конкуренция выбирается по версии, а не старшинству часов.
  let metadata = local.version < remote.version ? local.record : remote.record;
  if (localMetadataChanged && !remoteMetadataChanged) {
    metadata = local.record;
  }
  if (remoteMetadataChanged && !localMetadataChanged) {
    metadata = remote.record;
  }
  return portableEntity({ ...metadata, key, data }, [local.version, remote.version]);
}

/**
 * Применяет закрытый custom text patch, оставляя все остальные поля обычному трёхстороннему merge.
 * Новая запись получает авторство решения; совпадение с remote сохраняет прежнюю portable версию.
 */
function mergeDocumentText(
  base: PortableEntity | null,
  local: PortableEntity | null,
  remote: PortableEntity | null,
  override: ReplicationRecordOverride,
): PortableEntity {
  if (
    base?.record.kind !== "document" ||
    local?.record.kind !== "document" ||
    remote?.record.kind !== "document"
  ) {
    throw new RelayError("REPLICATION_RESOLUTION_SCOPE", replicationMessages.resolutionScope, 4);
  }
  const before = { ...base.record.data };
  const left = { ...local.record.data };
  const right = { ...remote.record.data };
  for (const field of override.fields.keys()) {
    delete before[field];
    delete left[field];
    delete right[field];
  }
  const data = mergeValue(before, left, right, "data", false);
  const key = mergeValue(base.record.key, local.record.key, remote.record.key, "key", false);
  if (!mergeObject(data) || typeof key !== "string") {
    throw new RelayError("REPLICATION_CONFLICT", replicationMessages.conflict, 4);
  }
  for (const [field, value] of override.fields) {
    data[field] = value;
  }
  if (key === remote.record.key && canonicalJson(data) === canonicalJson(remote.record.data)) {
    return remote;
  }
  return portableEntity(
    { ...remote.record, key, data, updatedBy: override.actor, updatedAt: override.timestamp },
    [local.version, remote.version],
  );
}
