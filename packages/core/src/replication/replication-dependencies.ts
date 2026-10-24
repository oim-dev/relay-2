import type { ReplicationConfirmation } from "@relay/contracts";
import type { ReplicationDependencySource } from "@relay/storage";
import { isConfirmed } from "./confirmations";
import { replicationMessages } from "./replication.messages";
import type { ReplicationDependencyWait } from "./replication-selection.types";

/**
 * Объясняет ожидание непринятых причинных ID; подтверждённый или готовый source возвращает null.
 * Вызывающий передаёт confirmations именно того шага, на котором требуется проверить dependencies.
 */
export function dependencyWait(
  source: ReplicationDependencySource,
  confirmations: readonly ReplicationConfirmation[],
): ReplicationDependencyWait | null {
  if (isConfirmed(confirmations, source.id)) {
    return null;
  }
  const dependencies = source.dependencies.filter((id) => !isConfirmed(confirmations, id));
  return dependencies.length === 0
    ? null
    : {
        id: source.id,
        state: "pending",
        code: "REPLICATION_DEPENDENCY",
        message: replicationMessages.dependency,
        dependencies,
      };
}
