import {
  RelayError,
  isPortableIdentityText,
  type ReplicationChangeset,
  type ReplicationDecision,
  type ReplicationResolution,
  type ReplicationDocumentTextPatch,
} from "@relay/contracts";
import { mergeObject } from "./record-merge";
import { replicationMessages } from "./replication.messages";
import type { ReplicationRecordOverride } from "./replication-resolution.types";

/**
 * Проверяет закрытый decision contract без изменения исходного source/receipt.
 */
export function assertReplicationDecision(value: unknown): asserts value is ReplicationDecision {
  if (
    !mergeObject(value) ||
    typeof value.fingerprint !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.fingerprint) ||
    !["local", "remote", "custom"].includes(String(value.choice))
  ) {
    throw new RelayError("INVALID_ARGUMENT", replicationMessages.decision, 2);
  }
  const allowed =
    value.choice === "custom" ? ["fingerprint", "choice", "patch"] : ["fingerprint", "choice"];
  if (Object.keys(value).some((field) => !allowed.includes(field))) {
    throw new RelayError("INVALID_ARGUMENT", replicationMessages.decision, 2);
  }
  if (value.choice !== "custom") {
    return;
  }
  if (!Array.isArray(value.patch) || value.patch.length === 0) {
    throw new RelayError("INVALID_ARGUMENT", replicationMessages.decision, 2);
  }
  const seen = new Set<string>();
  for (const patch of value.patch) {
    if (
      !mergeObject(patch) ||
      !Number.isSafeInteger(patch.transition) ||
      typeof patch.transition !== "number" ||
      patch.transition < 0 ||
      typeof patch.entityId !== "string" ||
      !patch.entityId ||
      !isPortableIdentityText(patch.entityId) ||
      !["name", "summary", "body"].includes(String(patch.field)) ||
      typeof patch.value !== "string" ||
      Object.keys(patch).some(
        (field) => !["transition", "entityId", "field", "value"].includes(field),
      )
    ) {
      throw new RelayError("INVALID_ARGUMENT", replicationMessages.decision, 2);
    }
    const key = JSON.stringify([patch.transition, patch.entityId, patch.field]);
    if (seen.has(key)) {
      throw new RelayError("INVALID_ARGUMENT", replicationMessages.decision, 2);
    }
    seen.add(key);
  }
}

/**
 * Не разрешает custom выходить за original effect scope или менять неизменяемую историю/квитанцию.
 */
export function validateResolutionScope(
  source: ReplicationChangeset,
  decision: ReplicationDecision,
): void {
  assertReplicationDecision(decision);
  if (decision.choice !== "custom") {
    return;
  }
  for (const patch of decision.patch) {
    const effects =
      source.transitions === undefined
        ? patch.transition === 0
          ? source.entities
          : undefined
        : source.transitions[patch.transition]?.entities;
    const change = effects?.find((entry) => entry.id === patch.entityId);
    if (
      change?.before?.record.kind !== "document" ||
      change.after?.record.kind !== "document" ||
      typeof change.after.record.data[patch.field] !== "string" ||
      change.before.record.data[patch.field] === change.after.record.data[patch.field]
    ) {
      throw new RelayError("REPLICATION_RESOLUTION_SCOPE", replicationMessages.resolutionScope, 4, {
        transition: patch.transition,
        entityId: patch.entityId,
        field: patch.field,
      });
    }
  }
}

/**
 * Выбирает только поправки данной command boundary; actor/time взяты из immutable решения.
 */
export function resolutionOverrides(
  resolution: ReplicationResolution | null,
  transition: number,
): ReadonlyMap<string, ReplicationRecordOverride> {
  const overrides = new Map<string, ReplicationRecordOverride>();
  if (resolution?.choice !== "custom") {
    return overrides;
  }
  for (const patch of resolution.patch.filter((entry) => entry.transition === transition)) {
    const existing = overrides.get(patch.entityId);
    const fields = new Map<ReplicationDocumentTextPatch["field"], string>(existing?.fields);
    fields.set(patch.field, patch.value);
    overrides.set(patch.entityId, {
      fields,
      actor: resolution.actor,
      timestamp: resolution.createdAt,
    });
  }
  return overrides;
}

/**
 * Получает пользовательскую часть решения, исключая его служебные immutable метаданные.
 */
export function resolutionDecision(resolution: ReplicationResolution): ReplicationDecision {
  return resolution.choice === "custom"
    ? { fingerprint: resolution.fingerprint, choice: "custom", patch: resolution.patch }
    : { fingerprint: resolution.fingerprint, choice: resolution.choice };
}
