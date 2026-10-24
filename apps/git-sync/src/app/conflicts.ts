import {
  RelayError,
  type ReplicationConflict,
  type ReplicationDecision,
  type ReplicationDocumentTextPatch,
  type GitSyncConflictSummary,
  type GitSyncConflictList,
  type GitSyncConflictDetails,
  type GitSyncConflictResolutionResult,
} from "@relay/contracts";
import type { ReplicationAdapter } from "../sync/replication-adapter";
import { appMessages } from "./app.messages";
import { requestObject, requiredString } from "./protocol";

/**
 * Проверяет форму явного решения; актуальность fingerprint и допустимость выбора принадлежат Core.
 */
export function conflictDecision(value: unknown): ReplicationDecision {
  const decision = requestObject(value);
  if (decision.choice === "custom") {
    if (
      !Array.isArray(decision.patch) ||
      Object.keys(decision).some((key) => !["choice", "fingerprint", "patch"].includes(key))
    ) {
      throw new RelayError("INVALID_ARGUMENT", appMessages.argument, 2);
    }
    const patch = decision.patch.map((raw): ReplicationDocumentTextPatch => {
      const item = requestObject(raw);
      if (
        Object.keys(item).some(
          (key) => !["transition", "entityId", "field", "value"].includes(key),
        ) ||
        typeof item.transition !== "number" ||
        !Number.isSafeInteger(item.transition) ||
        item.transition < 0 ||
        (item.field !== "body" && item.field !== "name" && item.field !== "summary") ||
        typeof item.value !== "string"
      ) {
        throw new RelayError("INVALID_ARGUMENT", appMessages.argument, 2);
      }
      return {
        transition: item.transition,
        entityId: requiredString(item.entityId),
        field: item.field,
        value: item.value,
      };
    });
    return { choice: "custom", fingerprint: requiredString(decision.fingerprint), patch };
  }
  if (decision.choice !== "local" && decision.choice !== "remote") {
    throw new RelayError("INVALID_ARGUMENT", appMessages.argument, 2);
  }
  if (Object.keys(decision).some((key) => !["choice", "fingerprint"].includes(key))) {
    throw new RelayError("INVALID_ARGUMENT", appMessages.argument, 2);
  }
  return { fingerprint: requiredString(decision.fingerprint), choice: decision.choice };
}

/**
 * Отделяет ограниченную диагностику списка от полных материалов конкретного конфликта.
 */
export function conflictSummary(conflict: ReplicationConflict): GitSyncConflictSummary {
  return {
    id: conflict.id,
    fingerprint: conflict.fingerprint,
    code: conflict.code,
    message: conflict.message,
  };
}

/**
 * Выполняет явную полную диагностику ожиданий; prepare/status этот scan не используют.
 */
export function listConflicts(replication: ReplicationAdapter): GitSyncConflictList {
  const diagnostics = replication.diagnostics();
  return {
    conflicts: diagnostics.conflicts.map(conflictSummary),
    blocked: diagnostics.blocked,
  };
}

/**
 * Объясняет либо сохранённые стороны, либо pending-зависимости без выдуманного fingerprint.
 */
export function getConflict(replication: ReplicationAdapter, id: string): GitSyncConflictDetails {
  const diagnostics = replication.diagnostics();
  const conflict = diagnostics.conflicts.find((item) => item.id === id);
  if (conflict) {
    return conflict;
  }
  const blocked = diagnostics.blocked.find((item) => item.id === id);
  if (blocked) {
    return blocked;
  }
  throw new RelayError("GIT_SYNC_CONFLICT_NOT_FOUND", appMessages.conflictMissing, 3);
}

/**
 * Сохраняет решение через Core и возвращает итог подготовки, исключая полный проектный snapshot.
 */
export function resolveConflictRequest(
  replication: ReplicationAdapter,
  input: Record<string, unknown>,
): GitSyncConflictResolutionResult {
  const id = requiredString(input.id);
  const details = getConflict(replication, id);
  if ("state" in details) {
    throw new RelayError("REPLICATION_DEPENDENCY", appMessages.blockedResolution, 4, {
      blocked: details,
    });
  }
  const prepared = replication.resolve(
    id,
    conflictDecision(input.decision),
    requiredString(input.actor),
  );
  return {
    id,
    generation: prepared.generation,
    included: prepared.included,
    ...listConflicts(replication),
    pending: replication.status().pending,
    deferred: prepared.selection.deferred,
    hasMore: prepared.selection.hasMore,
  };
}
