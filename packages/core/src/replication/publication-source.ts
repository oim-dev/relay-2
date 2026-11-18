import {
  RelayError,
  assertReplicationChangesetShape,
  assertReplicationTransitionShape,
  componentIdentity,
  validateActor,
  isPortableIdentityText,
  type ReplicationChangeset,
  type ReplicationTransition,
  type PortableProjectSnapshot,
} from "@relay/contracts";
import { replicationFingerprint, canonicalJson } from "@relay/storage";
import { assertComponents } from "./component-validation";
import { replicationMessages } from "./replication.messages";
import { assertSnapshot } from "./snapshot-validation";
import { assertPortableEntity } from "./portable-entity-validation";
import {
  assertInitialReplicationSource,
  assertSourceBoundaryParents,
} from "./source-boundary-parents";
import { assertNamedTransitionTargets } from "./transition-targets";

/**
 * Проверяет форму общим decoder Contracts, затем версии и предметный протокол источника до merge.
 * Без previous проверка не доказывает основание; replay передаёт фактическую canonical основу, чтобы
 * техническая инициализация не могла стать обычной мутацией существующего проекта.
 */
export function assertPublicationSource(
  value: unknown,
  previous?: PortableProjectSnapshot,
): asserts value is ReplicationChangeset {
  assertReplicationChangesetShape(value);
  if (
    !Number.isFinite(Date.parse(value.createdAt)) ||
    new Set(value.dependencies).size !== value.dependencies.length
  ) {
    throw new RelayError("REPLICATION_FORMAT", replicationMessages.format, 2, {
      path: "publication.source",
    });
  }
  const { digest, ...payload } = value;
  if (replicationFingerprint(payload) !== digest) {
    throw new RelayError("REPLICATION_ACK_MISMATCH", replicationMessages.publication, 4);
  }
  assertEffects(value, value.modelVersion === 2, value.transitions === undefined);
  assertEffectJournals(value, value.projectId);
  if (value.transitions !== undefined) {
    for (const step of value.transitions) {
      validateTransitionMaterial(step, value.projectId, value.modelVersion === 2);
    }
  }
  if (value.modelVersion === 2) {
    assertSourceTransitions(value, previous);
    assertTapeCoverage(value);
  } else if (value.components !== undefined || value.transitions !== undefined) {
    // Draft-v3 не имел независимых parts или tape; удаление modelVersion не создаёт legacy authority.
    throw new RelayError("REPLICATION_FORMAT", replicationMessages.format, 2, {
      path: "source.legacy.fields",
    });
  }
}

/**
 * Разделяет именованные команды и закрытую первоначальную инициализацию, а не уровень доверия имени.
 * Схлопнутая техническая мутация без доказанных границ отклоняется, её tape не выдумывается.
 */
function assertSourceTransitions(
  source: ReplicationChangeset,
  previous: PortableProjectSnapshot | undefined,
): void {
  const steps = source.transitions;
  if (steps === undefined || steps.length === 0) {
    throw new RelayError(
      "REPLICATION_TRANSITION_REQUIRED",
      replicationMessages.transitionMissing,
      4,
    );
  }
  const initial =
    source.mode === "baseline" ||
    steps.some((step) => ["baseline", "storage.atomic"].includes(step.command));
  if (initial) {
    assertInitialReplicationSource(source, previous);
  }
  for (const step of steps) {
    assertSourceBoundaryParents(step);
    if (!initial) {
      assertNamedTransitionTargets(step);
      assertTransitionMetadata(step);
    }
  }
}

/**
 * Проверяет форму source/effective boundary общим decoder и сохраняет предметные проверки Core.
 * Соответствие source actor/time проверяется отдельно:
 * merge или custom имеют собственную итоговую record metadata, связанную с publication/resolution.
 */
export function assertReplicationTransition(
  value: unknown,
  projectId: string,
  normalized: boolean,
): asserts value is ReplicationTransition {
  assertReplicationTransitionShape(value);
  validateTransitionMaterial(value, projectId, normalized);
}

/**
 * Проверяет техническую допустимость уже декодированной boundary без повторного обхода её JSON-формы.
 */
function validateTransitionMaterial(
  value: ReplicationTransition,
  projectId: string,
  normalized: boolean,
): void {
  if (
    !value.command ||
    (value.timestamp !== undefined && !Number.isFinite(Date.parse(value.timestamp)))
  ) {
    throw new RelayError("REPLICATION_FORMAT", replicationMessages.format, 2, {
      path: "publication.transition",
    });
  }
  validateActor(value.actor);
  if (!isPortableIdentityText(value.actor)) {
    throw new RelayError("REPLICATION_FORMAT", replicationMessages.format, 2, {
      path: "transition.actor.utf16",
    });
  }
  assertEffects(value, normalized);
  assertEffectJournals(value, projectId);
}

/**
 * Связывает источники именованной команды с уже выделенными actor/time, без чтения часов и winner policy.
 */
function assertTransitionMetadata(step: ReplicationTransition): void {
  if (typeof step.timestamp !== "string" || !Number.isFinite(Date.parse(step.timestamp))) {
    throw new RelayError("REPLICATION_FORMAT", replicationMessages.format, 2, {
      path: "transition.timestamp",
    });
  }
  for (const entry of step.entities) {
    if (
      entry.after === null ||
      entry.after.record.updatedBy !== step.actor ||
      entry.after.record.updatedAt !== step.timestamp ||
      (entry.before === null &&
        (entry.after.record.createdBy !== step.actor ||
          entry.after.record.createdAt !== step.timestamp))
    ) {
      throw new RelayError("REPLICATION_FORMAT", replicationMessages.format, 2, {
        path: "transition.entity.metadata",
      });
    }
  }
  for (const entry of step.comments) {
    if (entry.comment.createdBy !== step.actor || entry.comment.createdAt !== step.timestamp) {
      throw new RelayError("REPLICATION_FORMAT", replicationMessages.format, 2, {
        path: "transition.comment.metadata",
      });
    }
  }
}

/**
 * Не позволяет подтвердить source, часть эффектов которого потеряна либо заменена отдельной tape.
 */
function assertTapeCoverage(source: ReplicationChangeset): void {
  if (source.transitions === undefined) {
    return;
  }
  const entities = new Map<string, ReplicationTransition["entities"][number]>();
  const components = new Map<string, ReplicationTransition["components"][number]>();
  const addresses = new Map<string, ReplicationTransition["addresses"][number]>();
  const comments = new Map<string, ReplicationTransition["comments"][number]>();
  for (const step of source.transitions) {
    for (const entry of step.entities) {
      const prior = entities.get(entry.id);
      if (prior !== undefined && canonicalJson(prior.after) !== canonicalJson(entry.before)) {
        throw new RelayError("REPLICATION_PUBLICATION", replicationMessages.publication, 4, {
          path: "source.tape.entity",
        });
      }
      entities.set(entry.id, {
        ...entry,
        before: prior === undefined ? entry.before : prior.before,
      });
    }
    for (const part of step.components) {
      const prior = components.get(part.key);
      if (prior !== undefined && canonicalJson(prior.after) !== canonicalJson(part.before)) {
        throw new RelayError("REPLICATION_PUBLICATION", replicationMessages.publication, 4, {
          path: "source.tape.component",
        });
      }
      components.set(part.key, {
        ...part,
        before: prior === undefined ? part.before : prior.before,
      });
    }
    for (const entry of step.addresses) {
      addresses.set(entry.ref, entry);
    }
    for (const entry of step.comments) {
      comments.set(entry.comment.id, entry);
    }
    for (const guard of step.readContext) {
      if (
        guard.sourceChangesetId !== null &&
        !source.dependencies.includes(guard.sourceChangesetId)
      ) {
        throw new RelayError("REPLICATION_PUBLICATION", replicationMessages.publication, 4, {
          path: "source.dependencies",
        });
      }
    }
  }
  if (
    sortedEffects([...entities.values()]) !== sortedEffects(source.entities) ||
    sortedEffects([...components.values()]) !== sortedEffects(source.components ?? []) ||
    sortedEffects([...addresses.values()]) !== sortedEffects(source.addresses) ||
    sortedEffects([...comments.values()]) !== sortedEffects(source.comments)
  ) {
    throw new RelayError("REPLICATION_PUBLICATION", replicationMessages.publication, 4, {
      path: "source.tape.coverage",
    });
  }
}

/**
 * Сравнивает набор сохранённых effects без зависимости от SQL-порядка независимых owners.
 */
function sortedEffects(entries: readonly unknown[]): string {
  return canonicalJson(entries.map(canonicalJson).sort());
}

/**
 * Переиспользует общую проверку переносимых адресов, comments и исторических receipts без final doctor.
 */
function assertEffectJournals(
  value: Pick<ReplicationChangeset, "addresses" | "comments" | "receipts">,
  projectId: string,
): void {
  assertSnapshot({
    formatVersion: 1,
    projectId,
    entities: [],
    addresses: value.addresses,
    comments: value.comments,
    receipts: value.receipts,
    confirmations: [],
  });
}

/**
 * Не допускает подмены переносимой версии правильным digest всего внешнего контейнера.
 */
function assertEffects(
  value: Pick<ReplicationChangeset, "entities" | "components">,
  normalized: boolean,
  immediateParents = true,
): void {
  for (const change of value.entities) {
    for (const side of [change.before, change.after]) {
      if (side === null) {
        continue;
      }
      assertPortableEntity(side, !normalized);
      if (side.record.id !== change.id) {
        throw new RelayError("REPLICATION_FORMAT", replicationMessages.format, 2, {
          path: "effects.entity",
        });
      }
    }
    if (
      immediateParents &&
      change.before !== null &&
      change.after !== null &&
      change.before.version !== change.after.version &&
      !change.after.parents?.includes(change.before.version)
    ) {
      throw new RelayError("REPLICATION_FORMAT", replicationMessages.format, 2, {
        path: "effects.entity.parents",
      });
    }
  }
  if (normalized || value.components !== undefined) {
    if (value.components === undefined) {
      throw new RelayError("REPLICATION_FORMAT", replicationMessages.format, 2);
    }
    for (const component of value.components) {
      assertComponents([component.after]);
      if (component.before !== null) {
        assertComponents([component.before]);
      }
      if (
        component.key !== componentIdentity(component.after) ||
        (component.before !== null && componentIdentity(component.before) !== component.key)
      ) {
        throw new RelayError("REPLICATION_FORMAT", replicationMessages.format, 2, {
          path: "effects.component.key",
        });
      }
    }
  }
}
