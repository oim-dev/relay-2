import type {
  PortableProjectSnapshot,
  ReplicationChangeset,
  ReplicationKeyCollision,
  ReplicationKeyAssignment,
  PortableAddress,
} from "@relay/contracts";
import type {
  ReplicationKeyAddressIndex,
  ReplicationSourceKeyCollision,
} from "./key-collisions.types";

/**
 * Один раз индексирует весь address space; разные владельцы одного адреса сохраняются.
 */
export function indexKeyAddresses(
  local: Pick<PortableProjectSnapshot, "addresses">,
  remote: Pick<PortableProjectSnapshot, "addresses">,
  reservations: readonly ReplicationKeyAssignment[] = [],
): ReplicationKeyAddressIndex {
  const occupied = new Map<string, Set<string>>();
  for (const entry of [
    ...local.addresses,
    ...remote.addresses,
    ...reservations.map((assignment) => ({ ref: assignment.key, entityId: assignment.entityId })),
  ]) {
    const owners = occupied.get(entry.ref) ?? new Set<string>();
    owners.add(entry.entityId);
    occupied.set(entry.ref, owners);
  }
  return {
    accepted: new Map(remote.addresses.map((entry) => [entry.ref, entry.entityId])),
    occupied,
  };
}

/**
 * Предлагает следующий свободный номер без назначения адреса.
 * BigInt сохраняет точность любого допустимого десятичного суффикса.
 */
export function availableProvisionalKey(
  key: string,
  occupied: ReadonlyMap<string, unknown>,
  proposed: ReadonlySet<string>,
): string {
  const match = /^(.*)-(\d+)$/.exec(key);
  const prefix = match?.[1] ?? key;
  let number = BigInt(match?.[2] ?? "1");
  while (true) {
    const candidate = `${prefix}-${++number}`;
    if (!occupied.has(candidate) && !proposed.has(candidate)) {
      return candidate;
    }
  }
}

/**
 * Выделяет новые назначения каждой исходной boundary, включая промежуточные ключи до rename.
 * Прежние принятые aliases не входят в выборку; повторный возврат к уже назначенному ключу не дублируется.
 */
export function sourceKeyAssignments(source: ReplicationChangeset): readonly PortableAddress[] {
  const proposals = new Map<string, PortableAddress>();
  for (const step of source.transitions ?? [source]) {
    const current = new Map(
      step.entities.flatMap((change) =>
        change.after === null ? [] : [[change.id, change.after.record.key] as const],
      ),
    );
    for (const assignment of step.addresses) {
      if (
        assignment.ref !== assignment.entityId &&
        current.get(assignment.entityId) === assignment.ref
      ) {
        proposals.set(JSON.stringify([assignment.entityId, assignment.ref]), assignment);
      }
    }
  }
  return [...proposals.values()];
}

/**
 * Находит столкновения исходных назначений по всей ленте, не только её конечному current key.
 */
export function sourceKeyCollisions(
  source: ReplicationChangeset,
  accepted: ReadonlyMap<string, string>,
): ReplicationSourceKeyCollision[] {
  return sourceKeyAssignments(source).flatMap(({ entityId, ref }) => {
    const acceptedOwnerId = accepted.get(ref);
    return acceptedOwnerId === undefined || acceptedOwnerId === entityId
      ? []
      : [{ entityId, key: ref, acceptedOwnerId }];
  });
}

/**
 * Предлагает разные свободные номера на общем индексе local/remote, не резервируя адресов.
 * Общий proposed пополняется лишь предложениями данного чтения, без копирования полного индекса.
 */
export function suggestKeyCollisions(
  source: ReplicationChangeset,
  addresses: ReplicationKeyAddressIndex,
  proposed: Set<string>,
): ReplicationKeyCollision[] {
  return sourceKeyCollisions(source, addresses.accepted).map((collision) => {
    const suggestedKey = availableProvisionalKey(collision.key, addresses.occupied, proposed);
    proposed.add(suggestedKey);
    return { ...collision, suggestedKey };
  });
}
