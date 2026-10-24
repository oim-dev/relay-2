import { createHash } from "node:crypto";
import {
  componentIdentity,
  type EntityRecord,
  type PortableEntity,
  type PortableEntityRecord,
} from "@relay/contracts";
import type { PortableAggregateRoot, PortableAggregatePart } from "./replication.types";

const immutableJson = new WeakMap<object, string>();
const immutableDigests = new WeakMap<object, string>();
const immutableValues = new WeakSet<object>();

/**
 * Канонизирует JSON, сортируя только ключи объектов; порядок массивов и текст сохраняются.
 * undefined допускается только как отсутствующее свойство объекта.
 */
export function canonicalJson(value: unknown): string {
  if (value !== null && typeof value === "object") {
    const cached = immutableJson.get(value);
    if (cached !== undefined) {
      return cached;
    }
  }
  const json = canonicalJsonValue(value);
  if (value !== null && typeof value === "object" && isImmutableJson(value, new Set())) {
    immutableJson.set(value, json);
  }
  return json;
}

/**
 * Сериализует значения без кеширования каждого вложенного тела; порядок значимых массивов неизменен.
 */
function canonicalJsonValue(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJsonValue(entry)).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJsonValue(entry)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/**
 * Кеш допускает лишь транзитивно frozen plain JSON с data properties: shallow freeze/getters/Date не proof.
 */
function isImmutableJson(value: unknown, visited: Set<object>): boolean {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    value === undefined
  ) {
    return true;
  }
  if (typeof value === "number") {
    return Number.isFinite(value);
  }
  if (typeof value !== "object") {
    return false;
  }
  if (immutableValues.has(value)) {
    return true;
  }
  if (
    !Object.isFrozen(value) ||
    visited.has(value) ||
    (!Array.isArray(value) &&
      Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null)
  ) {
    return false;
  }
  visited.add(value);
  for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
    if (!Object.hasOwn(descriptor, "value") || !isImmutableJson(descriptor.value, visited)) {
      visited.delete(value);
      return false;
    }
  }
  visited.delete(value);
  immutableValues.add(value);
  return true;
}

/**
 * Возвращает SHA-256 канонического JSON; часы и локальная ревизия не выбирают победителя.
 */
export function replicationFingerprint(value: unknown): string {
  if (value !== null && typeof value === "object") {
    const known = immutableDigests.get(value);
    if (known !== undefined) {
      return known;
    }
  }
  const digest = createHash("sha256").update(canonicalJson(value)).digest("hex");
  if (value !== null && typeof value === "object" && immutableJson.has(value)) {
    immutableDigests.set(value, digest);
  }
  return digest;
}

/**
 * Сохраняет сырую карточку без независимой проекции comments и вычисляет переносимую версию.
 * Числовой revision исключён и из payload, и из идентичности версии; data не нормализуется.
 */
export function portableEntity(
  entity: EntityRecord | PortableEntityRecord,
  previous: readonly string[] = [],
): PortableEntity {
  const { revision: _revision, ...record } = structuredClone({ ...entity, revision: 0 });
  if (record.kind === "task") {
    delete record.data.comments;
  }
  const parents = [...new Set(previous)].sort();
  return { record, parents, version: replicationFingerprint({ ...record, parents }) };
}

/**
 * Версия публичного raw aggregate: primary owner и все его независимо версионируемые parts.
 * Comments остаются независимыми; local revision не входит в токен и не может выбрать победителя.
 */
export function portableAggregateVersion(
  entity: PortableAggregateRoot,
  components: readonly PortableAggregatePart[],
): string {
  return replicationFingerprint({
    entity: entity.version,
    components: components
      .filter((part) => part.ownerId === entity.record.id)
      .map((part) => [componentIdentity(part), part.version] as const)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)),
  });
}
