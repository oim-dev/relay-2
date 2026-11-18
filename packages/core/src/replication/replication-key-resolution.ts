import {
  RelayError,
  type PortableProjectSnapshot,
  type ReplicationChangeset,
  type ReplicationKeyConflict,
  type ReplicationKeyDecision,
  type ReplicationKeyAssignment,
  type ReplicationConflict,
} from "@relay/contracts";
import {
  canonicalJson,
  replicationFingerprint,
  type StoredReplicationDecision,
} from "@relay/storage";
import { createReplicationConflict, resolutionRemoteDigest } from "./conflict-material";
import { isConfirmed } from "./confirmations";
import { suggestKeyCollisions } from "./key-collisions";
import type { ReplicationKeyAddressIndex } from "./key-collisions.types";
import { resolveKeyAssignmentScope, validateKeyAssignments } from "./key-resolution";
import { portableResolution, prepareReplication } from "./replication-preparation";
import { confirmedResolution } from "./resolution-acceptance";
import { decisionApplies, resolutionLocalSources } from "./resolution-application";
import { replicationMessages } from "./replication.messages";
import type { ReplicationContext } from "./replication-context.types";
import type { PreparedKeyResolution } from "./replication-key-resolution.types";

/**
 * Представляет сохранённый материал и свежие предложения по узкому индексу адресов.
 * Fingerprint относится к последней подготовке; resolve повторно проверяет его актуальность.
 */
export function keyConflictDiagnostics(
  conflicts: readonly ReplicationConflict[],
  addresses: ReplicationKeyAddressIndex,
  decisions: readonly StoredReplicationDecision[],
): ReplicationKeyConflict[] {
  const pendingById = new Map(decisions.map((entry) => [entry.id, entry]));
  const proposed = new Set<string>();
  return conflicts.flatMap((conflict): ReplicationKeyConflict[] => {
    const pending = pendingById.get(conflict.id);
    if (conflict.code === "REPLICATION_RESOLUTION_STALE" && pending?.choice === "keys") {
      const resolution = portableResolution(pending);
      if (resolution.choice !== "keys") {
        return [];
      }
      return [
        {
          id: conflict.id,
          fingerprint: conflict.fingerprint,
          code: "REPLICATION_RESOLUTION_STALE",
          message: replicationMessages.resolutionStale,
          collisions: [],
          pendingResolution: resolution,
          acceptedResolutionId: conflict.acceptedResolutionId ?? null,
        },
      ];
    }
    const collisions = suggestKeyCollisions(conflict.changeset, addresses, proposed);
    return collisions.length === 0
      ? []
      : [
          {
            id: conflict.id,
            fingerprint: conflict.fingerprint,
            code: "REPLICATION_KEY_COLLISION",
            message: replicationMessages.keyCollision,
            collisions,
          },
        ];
  });
}

/**
 * Учитывает уже выбранные актуальные назначения pending sources, ещё не импортированные локально.
 * Исключаемый changeset вправе заменить собственное предложение; stale решения адрес не занимают.
 */
function pendingKeyAssignments(
  context: ReplicationContext,
  remote: PortableProjectSnapshot,
  exceptId?: string,
): ReplicationKeyAssignment[] {
  const sources = new Map(context.outbox.map((source) => [source.id, source]));
  return context.decisions.flatMap((decision) => {
    const source = sources.get(decision.id);
    return decision.choice === "keys" &&
      decision.id !== exceptId &&
      source !== undefined &&
      !isConfirmed(remote.confirmations, source.id) &&
      decisionApplies(source, context.local, remote, context.outbox, context.decisions, decision)
      ? [...decision.assignments]
      : [];
  });
}

/**
 * Сопоставляет точный пользовательский выбор с immutable-записью; порядок назначений незначим.
 */
function sameKeyDecision(
  previous: StoredReplicationDecision | undefined,
  decision: ReplicationKeyDecision,
  actor: string,
): boolean {
  if (
    previous?.choice !== "keys" ||
    previous.fingerprint !== decision.fingerprint ||
    previous.actor !== actor
  ) {
    return false;
  }
  const accepted = new Map(
    previous.material.remoteAddresses.map((entry) => [entry.ref, entry.entityId]),
  );
  return (
    canonicalJson(resolveKeyAssignmentScope(previous.material.changeset, decision, accepted)) ===
    canonicalJson(
      resolveKeyAssignmentScope(
        previous.material.changeset,
        {
          fingerprint: previous.fingerprint,
          assignments: previous.assignments,
        },
        accepted,
      ),
    )
  );
}

/**
 * Выделяет immutable-решение один раз, сохраняя исходный source, receipt и просмотренный контекст.
 */
function newKeyResolution(
  context: ReplicationContext,
  remote: PortableProjectSnapshot,
  source: ReplicationChangeset,
  decision: ReplicationKeyDecision,
  actor: string,
): StoredReplicationDecision {
  const material = createReplicationConflict(
    { code: "REPLICATION_KEY_COLLISION", message: replicationMessages.keyCollision },
    source,
    context.local,
    remote,
  );
  if (material.fingerprint !== decision.fingerprint) {
    throw new RelayError("REPLICATION_STALE", replicationMessages.stale, 4);
  }
  const assignments = validateKeyAssignments(
    source,
    decision,
    context.local,
    remote,
    pendingKeyAssignments(context, remote, source.id),
  );
  const resolution = {
    formatVersion: 1 as const,
    changesetId: source.id,
    choice: "keys" as const,
    fingerprint: decision.fingerprint,
    assignments,
    actor,
    createdAt: new Date().toISOString(),
    sourceDigest: source.digest,
    remoteDigest: resolutionRemoteDigest(source, remote),
    material,
  };
  const identity = {
    ...resolution,
    id: source.id,
    resolutionId: replicationFingerprint(resolution),
  };
  const choices = [...context.decisions.filter((entry) => entry.id !== source.id), identity];
  return {
    ...identity,
    localSources: resolutionLocalSources(source, context.outbox, remote, choices),
  };
}

/**
 * Проверяет явный выбор на полном overlay; повтор после acceptance сверяется с exact proof.
 * Устаревший или занятый выбор отклоняется до записи; повтор не создаёт нового resolutionId.
 */
export function prepareKeyResolution(
  context: ReplicationContext,
  remote: PortableProjectSnapshot,
  changesetId: string,
  input: ReplicationKeyDecision,
  actor: string,
  previous: StoredReplicationDecision | undefined,
): PreparedKeyResolution {
  const same = sameKeyDecision(previous, input, actor);
  const accepted = isConfirmed(remote.confirmations, changesetId);
  let stored: StoredReplicationDecision | null = null;
  if (accepted) {
    if (
      !same ||
      previous === undefined ||
      confirmedResolution(remote, changesetId) !== previous.resolutionId
    ) {
      throw new RelayError("REPLICATION_ALREADY_ACCEPTED", replicationMessages.alreadyAccepted, 4, {
        changesetId,
      });
    }
  } else {
    const source = context.outbox.find((entry) => entry.id === changesetId);
    if (source === undefined) {
      throw new RelayError("NOT_FOUND", replicationMessages.missing, 3);
    }
    if (same && previous !== undefined) {
      if (
        !decisionApplies(source, context.local, remote, context.outbox, context.decisions, previous)
      ) {
        throw new RelayError("REPLICATION_STALE", replicationMessages.stale, 4);
      }
      validateKeyAssignments(
        source,
        input,
        context.local,
        remote,
        pendingKeyAssignments(context, remote, source.id),
      );
    } else {
      stored = newKeyResolution(context, remote, source, input, actor);
    }
  }
  const decisions =
    stored === null
      ? context.decisions
      : [...context.decisions.filter((entry) => entry.id !== changesetId), stored];
  const validated = prepareReplication(
    context.local,
    remote,
    context.outbox,
    decisions,
    context.generation,
  );
  const rejected = validated.conflicts.find((entry) => entry.id === changesetId);
  if (rejected !== undefined) {
    throw new RelayError(rejected.code, rejected.message, 4, {
      conflictId: changesetId,
      fingerprint: rejected.fingerprint,
    });
  }
  if (validated.deferred.some((entry) => entry.id === changesetId)) {
    throw new RelayError("REPLICATION_DEPENDENCY", replicationMessages.dependency, 4);
  }
  return { decision: stored, decisions, validated };
}
