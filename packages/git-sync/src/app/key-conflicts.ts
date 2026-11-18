import {
  RelayError,
  type GitSyncConflictResolutionResult,
  type ReplicationKeyDecision,
} from "@relay/contracts";
import type { ReplicationAdapter } from "../sync/replication-adapter";
import { appMessages } from "./app.messages";
import { conflictResolutionResult } from "./conflicts";
import { requestObject, requiredString } from "./protocol";

/**
 * Проверяет закрытую форму выбранных ключей; свободность, область и fingerprint проверяет Core.
 * Строки и порядок назначений передаются дословно, без выбора нового номера на транспортной границе.
 */
export function keyConflictDecision(value: unknown): ReplicationKeyDecision {
  const decision = requestObject(value);
  if (
    !Array.isArray(decision.assignments) ||
    Object.keys(decision).some((key) => !["fingerprint", "assignments"].includes(key))
  ) {
    throw new RelayError("INVALID_ARGUMENT", appMessages.argument, 2);
  }
  const assignments = decision.assignments.map((raw) => {
    const assignment = requestObject(raw);
    if (Object.keys(assignment).some((key) => !["entityId", "fromKey", "key"].includes(key))) {
      throw new RelayError("INVALID_ARGUMENT", appMessages.argument, 2);
    }
    return {
      entityId: requiredString(assignment.entityId),
      key: requiredString(assignment.key),
      ...(assignment.fromKey === undefined ? {} : { fromKey: requiredString(assignment.fromKey) }),
    };
  });
  return { fingerprint: requiredString(decision.fingerprint), assignments };
}

/**
 * Сохраняет решение коллизии через Core и возвращает компактный результат подготовки.
 * Предварительный поиск открытого конфликта не выполняется: Core распознаёт повтор после acceptance.
 */
export function resolveKeyConflictRequest(
  replication: ReplicationAdapter,
  input: Record<string, unknown>,
): GitSyncConflictResolutionResult {
  const id = requiredString(input.id);
  const prepared = replication.resolveKeys(
    id,
    keyConflictDecision(input.decision),
    requiredString(input.actor),
  );
  return conflictResolutionResult(replication, id, prepared);
}
