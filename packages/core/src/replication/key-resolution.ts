import {
  RelayError,
  isPortableIdentityText,
  type PortableProjectSnapshot,
  type ReplicationChangeset,
  type ReplicationKeyDecision,
  type ReplicationKeyAssignment,
} from "@relay/contracts";
import { validateEntityAddress } from "../entities/entity-validation";
import { mergeObject } from "./record-merge";
import { indexKeyAddresses, sourceKeyAssignments, sourceKeyCollisions } from "./key-collisions";
import type { ResolvedReplicationKeyAssignment } from "./key-collisions.types";
import { replicationMessages } from "./replication.messages";

/**
 * Проверяет отдельный закрытый ввод выбора ключей без исправления строк или изменения входа.
 */
export function assertReplicationKeyDecision(
  value: unknown,
): asserts value is ReplicationKeyDecision {
  if (
    !mergeObject(value) ||
    typeof value.fingerprint !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.fingerprint) ||
    Object.keys(value).some((field) => !["fingerprint", "assignments"].includes(field)) ||
    !Array.isArray(value.assignments) ||
    value.assignments.length === 0
  ) {
    throw new RelayError("INVALID_ARGUMENT", replicationMessages.keyDecision, 2);
  }
  const targets = new Set<string>();
  const implicit = new Set<string>();
  const owners = new Set<string>();
  const keys = new Set<string>();
  for (const assignment of value.assignments) {
    if (
      !mergeObject(assignment) ||
      typeof assignment.entityId !== "string" ||
      !assignment.entityId ||
      !isPortableIdentityText(assignment.entityId) ||
      typeof assignment.key !== "string" ||
      (Object.hasOwn(assignment, "fromKey") && typeof assignment.fromKey !== "string") ||
      Object.keys(assignment).some((field) => !["entityId", "fromKey", "key"].includes(field)) ||
      targets.has(JSON.stringify([assignment.entityId, assignment.fromKey])) ||
      implicit.has(assignment.entityId) ||
      (assignment.fromKey === undefined && owners.has(assignment.entityId)) ||
      keys.has(assignment.key)
    ) {
      throw new RelayError("INVALID_ARGUMENT", replicationMessages.keyDecision, 2);
    }
    validateEntityAddress(assignment.key, "key");
    if (assignment.fromKey !== undefined) {
      validateEntityAddress(assignment.fromKey, "key");
    } else {
      implicit.add(assignment.entityId);
    }
    owners.add(assignment.entityId);
    targets.add(JSON.stringify([assignment.entityId, assignment.fromKey]));
    keys.add(assignment.key);
  }
}

/**
 * Разрешает лишь новое назначение из исходного source, сохраняя префикс числового ключа.
 * Идентичность, тексты, временные метки и подтверждённые назначения не являются областью решения.
 */
export function validateKeyResolutionScope(
  source: ReplicationChangeset,
  decision: ReplicationKeyDecision,
): void {
  assertReplicationKeyDecision(decision);
  const proposals = sourceKeyAssignments(source);
  for (const assignment of decision.assignments) {
    const possible = proposals.filter(
      (entry) =>
        entry.entityId === assignment.entityId &&
        (assignment.fromKey === undefined || assignment.fromKey === entry.ref),
    );
    if (!possible.some((entry) => validReplacementKey(entry.ref, assignment.key))) {
      throw new RelayError("REPLICATION_RESOLUTION_SCOPE", replicationMessages.keyScope, 4, {
        entityId: assignment.entityId,
        key: assignment.key,
      });
    }
  }
}

/**
 * Проверяет новый номер в прежнем префиксе; нечисловой исходный ключ допускает иной валидный адрес.
 */
function validReplacementKey(original: string, selected: string): boolean {
  const numbered = /^(.*)-(\d+)$/.exec(original);
  const replacement = /^(.*)-([1-9]\d*)$/.exec(selected);
  return (
    original !== selected &&
    (numbered === null || (replacement !== null && numbered[1] === replacement[1]))
  );
}

/**
 * Разрешает сокращённый ввод по фактическим столкновениям и требует весь атомарный набор.
 * Возвращает стабильный порядок entityId/fromKey; неоднозначный ID без fromKey отклоняется.
 */
export function resolveKeyAssignmentScope(
  source: ReplicationChangeset,
  decision: ReplicationKeyDecision,
  accepted: ReadonlyMap<string, string>,
): readonly ResolvedReplicationKeyAssignment[] {
  validateKeyResolutionScope(source, decision);
  const collisions = sourceKeyCollisions(source, accepted);
  const selected = decision.assignments.map((assignment) => {
    const matches = collisions.filter(
      (entry) =>
        entry.entityId === assignment.entityId &&
        (assignment.fromKey === undefined || assignment.fromKey === entry.key),
    );
    const match = matches[0];
    if (
      matches.length !== 1 ||
      match === undefined ||
      !validReplacementKey(match.key, assignment.key)
    ) {
      throw new RelayError("REPLICATION_RESOLUTION_SCOPE", replicationMessages.keyScope, 4, {
        entityId: assignment.entityId,
        fromKeys: matches.map((entry) => entry.key),
      });
    }
    return { entityId: assignment.entityId, fromKey: match.key, key: assignment.key };
  });
  if (selected.length !== collisions.length) {
    throw new RelayError("REPLICATION_RESOLUTION_SCOPE", replicationMessages.keyScope, 4);
  }
  return selected.sort((a, b) => {
    const left = JSON.stringify([a.entityId, a.fromKey]);
    const right = JSON.stringify([b.entityId, b.fromKey]);
    return left < right ? -1 : left > right ? 1 : 0;
  });
}

/**
 * Проверяет полный набор коллизий и свободность выбранных адресов на согласованном overlay.
 * Повторная проверка перед применением также учитывает предшествующие sources той же публикации.
 */
export function validateKeyAssignments(
  source: ReplicationChangeset,
  decision: ReplicationKeyDecision,
  local: PortableProjectSnapshot,
  remote: PortableProjectSnapshot,
  reservations: readonly ReplicationKeyAssignment[] = [],
): readonly ResolvedReplicationKeyAssignment[] {
  const addresses = indexKeyAddresses(local, remote, reservations);
  const assignments = resolveKeyAssignmentScope(source, decision, addresses.accepted);
  for (const assignment of assignments) {
    const occupied = [...(addresses.occupied.get(assignment.key) ?? [])].find(
      (id) => id !== assignment.entityId,
    );
    if (occupied !== undefined) {
      throw new RelayError("REPLICATION_ADDRESS", replicationMessages.keyOccupied, 4, {
        ref: assignment.key,
        entityId: assignment.entityId,
        owner: occupied,
      });
    }
  }
  return assignments;
}
