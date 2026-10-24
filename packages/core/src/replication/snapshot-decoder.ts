import type { PortableProjectSnapshot } from "@relay/contracts";
import { canonicalJson, replicationFingerprint } from "@relay/storage";
import { createHash } from "node:crypto";
import { validateEntityData } from "../entities/entity-validation";
import { assertSnapshot, validateSnapshot } from "./snapshot-validation";
import { canonicalSnapshot } from "./snapshot-canonical";
import { validatePublicationEnvelope } from "./publication-envelope";
import type {
  DecodedSnapshotCacheEntry,
  DecodedReplicationSnapshot,
} from "./snapshot-decoder.types";

const SNAPSHOT_CACHE_ENTRIES = 128;
const SNAPSHOT_CACHE_BYTES = 64 * 1024 * 1024;
const decodedKeys = new WeakMap<object, string>();
const snapshots = new Map<string, DecodedSnapshotCacheEntry>();
const aliases = new Map<string, string>();
let retainedBytes = 0;

/**
 * Узнаёт только проверенные этим Core транзитивно immutable снимки; frozen объект caller не является proof.
 */
export function isDecodedReplicationSnapshot(value: unknown): value is DecodedReplicationSnapshot {
  return value !== null && typeof value === "object" && decodedKeys.has(value);
}

/**
 * Адресует весь snapshot, включая исходные payload/эффективную tape и полные ack bindings.
 * Для собственной immutable копии стоимость постоянная; изменяемый вход проверяется и хешируется заново.
 */
export function replicationSnapshotKey(value: PortableProjectSnapshot): string {
  const cached = decodedKeys.get(value);
  if (cached !== undefined) {
    return cached;
  }
  validateEntityData(value);
  return replicationFingerprint(canonicalSnapshot(value));
}

/**
 * Декодирует недоверенный JSON без изменения caller объекта. State/envelope проверяются один раз
 * на точное содержимое, затем возвращается транзитивно frozen копия; проверка истории остаётся отдельной.
 */
export function decodeReplicationSnapshot(value: unknown): PortableProjectSnapshot {
  if (isDecodedReplicationSnapshot(value)) {
    return value;
  }
  validateEntityData(value);
  const copy: unknown = structuredClone(value);
  validateEntityData(copy);
  const serialized = canonicalJson(copy);
  const inputKey = createHash("sha256").update(serialized).digest("hex");
  const knownKey = aliases.get(inputKey) ?? inputKey;
  const known = snapshots.get(knownKey);
  if (known !== undefined) {
    snapshots.delete(knownKey);
    snapshots.set(knownKey, known);
    return known.snapshot;
  }
  assertSnapshot(copy);
  const snapshot = canonicalSnapshot(copy);
  const canonicalText = canonicalJson(snapshot);
  const key = createHash("sha256").update(canonicalText).digest("hex");
  const canonical = snapshots.get(key);
  if (canonical !== undefined) {
    snapshots.delete(key);
    snapshots.set(key, canonical);
    rememberAlias(inputKey, key);
    return canonical.snapshot;
  }
  validateSnapshot(snapshot);
  if (snapshot.publication != null) {
    validatePublicationEnvelope(snapshot);
  }
  return retainSnapshot(snapshot, key, inputKey, Buffer.byteLength(canonicalText, "utf8"));
}

/**
 * Запечатывает результат собственного checked builder: source/decisions/каждая boundary уже проверены,
 * а publishChanges сформировал согласованный envelope. Функция не экспортируется через публичный Core API.
 */
export function sealCalculatedReplicationSnapshot(
  value: PortableProjectSnapshot,
): PortableProjectSnapshot {
  if (isDecodedReplicationSnapshot(value)) {
    return value;
  }
  const snapshot = canonicalSnapshot(structuredClone(value));
  validateEntityData(snapshot);
  const text = canonicalJson(snapshot);
  const key = createHash("sha256").update(text).digest("hex");
  const previous = snapshots.get(key);
  if (previous !== undefined) {
    return previous.snapshot;
  }
  return retainSnapshot(snapshot, key, key, Buffer.byteLength(text, "utf8"));
}

/**
 * Хранит только проверенную принадлежащую Core копию, ограничивая суммарный retained JSON.
 */
function retainSnapshot(
  snapshot: PortableProjectSnapshot,
  key: string,
  inputKey: string,
  bytes: number,
): PortableProjectSnapshot {
  freezeJson(snapshot, new Set());
  decodedKeys.set(snapshot, key);
  if (bytes <= SNAPSHOT_CACHE_BYTES) {
    const previous = snapshots.get(key);
    if (previous !== undefined) {
      retainedBytes -= previous.bytes;
      snapshots.delete(key);
    }
    snapshots.set(key, { snapshot, bytes });
    retainedBytes += bytes;
    rememberAlias(inputKey, key);
    while (snapshots.size > SNAPSHOT_CACHE_ENTRIES || retainedBytes > SNAPSHOT_CACHE_BYTES) {
      const oldest = snapshots.entries().next().value;
      if (oldest === undefined) {
        break;
      }
      snapshots.delete(oldest[0]);
      retainedBytes -= oldest[1].bytes;
    }
  }
  return snapshot;
}

/**
 * Сохраняет лишь ограниченную связь входного порядка наборов с уже проверенным canonical content key.
 */
function rememberAlias(input: string, canonical: string): void {
  aliases.delete(input);
  aliases.set(input, canonical);
  while (aliases.size > SNAPSHOT_CACHE_ENTRIES * 2) {
    const oldest = aliases.keys().next().value;
    if (oldest !== undefined) {
      aliases.delete(oldest);
    }
  }
}

/**
 * Замораживает уже проверенное JSON-дерево; Set сохраняет допустимый aliasing без повторного обхода.
 */
function freezeJson(value: unknown, seen: Set<object>): void {
  if (value === null || typeof value !== "object" || seen.has(value)) {
    return;
  }
  seen.add(value);
  for (const child of Object.values(value)) {
    freezeJson(child, seen);
  }
  Object.freeze(value);
}
