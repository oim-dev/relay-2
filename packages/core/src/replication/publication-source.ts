import {
  RelayError,
  componentIdentity,
  isEntityKind,
  validateActor,
  isPortableIdentityText,
  type ReplicationChangeset,
  type ReplicationTransition,
  type PortableProjectSnapshot,
} from "@relay/contracts";
import { replicationFingerprint, canonicalJson } from "@relay/storage";
import { assertComponents } from "./component-validation";
import { mergeObject } from "./record-merge";
import { replicationMessages } from "./replication.messages";
import { assertSnapshot } from "./snapshot-validation";
import { assertPortableEntity } from "./portable-entity-validation";
import {
  assertInitialReplicationSource,
  assertSourceBoundaryParents,
} from "./source-boundary-parents";
import { assertNamedTransitionTargets } from "./transition-targets";

/**
 * Проверяет payload источника до merge: валидный digest не заменяет проверку версий его сторон.
 * Decoder проверяет форму без previous; replay передаёт фактическую canonical основу, чтобы
 * техническая инициализация не могла стать обычной мутацией существующего проекта.
 */
export function assertPublicationSource(
  value: unknown,
  previous?: PortableProjectSnapshot,
): asserts value is ReplicationChangeset {
  if (
    !mergeObject(value) ||
    value.formatVersion !== 1 ||
    (value.modelVersion !== undefined && value.modelVersion !== 2) ||
    typeof value.projectId !== "string" ||
    typeof value.id !== "string" ||
    typeof value.replicaId !== "string" ||
    !Number.isSafeInteger(value.sequence) ||
    typeof value.sequence !== "number" ||
    value.sequence < 1 ||
    !["baseline", "mutation"].includes(String(value.mode)) ||
    typeof value.digest !== "string" ||
    typeof value.createdAt !== "string" ||
    !Number.isFinite(Date.parse(value.createdAt)) ||
    !Array.isArray(value.dependencies) ||
    value.dependencies.some((entry) => typeof entry !== "string") ||
    new Set(value.dependencies).size !== value.dependencies.length ||
    !Array.isArray(value.readContext)
  ) {
    throw new RelayError("REPLICATION_FORMAT", replicationMessages.format, 2, {
      path: "publication.source",
    });
  }
  const { digest, ...payload } = value;
  if (replicationFingerprint(payload) !== digest) {
    throw new RelayError("REPLICATION_ACK_MISMATCH", replicationMessages.publication, 4);
  }
  assertReadContext(value.readContext);
  if (
    ![value.projectId, value.id, value.replicaId].every(isPortableIdentityText) ||
    value.dependencies.some((id) => !isPortableIdentityText(id))
  ) {
    throw new RelayError("REPLICATION_FORMAT", replicationMessages.format, 2, {
      path: "source.identity.utf16",
    });
  }
  assertEffects(value, value.modelVersion === 2, value.transitions === undefined);
  assertEffectJournals(value, value.projectId);
  if (value.transitions !== undefined) {
    if (!Array.isArray(value.transitions)) {
      throw new RelayError("REPLICATION_FORMAT", replicationMessages.format, 2);
    }
    for (const step of value.transitions) {
      assertReplicationTransition(step, value.projectId, value.modelVersion === 2);
    }
  }
  if (value.modelVersion === 2) {
    // Поля проверены выше; семантический контракт и coverage связывают tape с исходными effects.
    const source = value as unknown as ReplicationChangeset;
    assertSourceTransitions(source, previous);
    assertTapeCoverage(source);
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
 * Проверяет форму source/effective boundary. Соответствие source actor/time проверяется отдельно:
 * merge или custom имеют собственную итоговую record metadata, связанную с publication/resolution.
 */
export function assertReplicationTransition(
  value: unknown,
  projectId: string,
  normalized: boolean,
): asserts value is ReplicationTransition {
  if (
    !mergeObject(value) ||
    typeof value.command !== "string" ||
    !value.command ||
    typeof value.actor !== "string" ||
    !Array.isArray(value.readContext) ||
    (value.timestamp !== undefined &&
      (typeof value.timestamp !== "string" || !Number.isFinite(Date.parse(value.timestamp))))
  ) {
    throw new RelayError("REPLICATION_FORMAT", replicationMessages.format, 2, {
      path: "publication.transition",
    });
  }
  if (
    Object.keys(value).some(
      (field) =>
        ![
          "command",
          "actor",
          "timestamp",
          "targets",
          "entities",
          "components",
          "addresses",
          "comments",
          "receipts",
          "readContext",
          "predicates",
        ].includes(field),
    )
  ) {
    throw new RelayError("REPLICATION_FORMAT", replicationMessages.format, 2, {
      path: "transition.fields",
    });
  }
  validateActor(value.actor);
  if (!isPortableIdentityText(value.actor)) {
    throw new RelayError("REPLICATION_FORMAT", replicationMessages.format, 2, {
      path: "transition.actor.utf16",
    });
  }
  assertReadContext(value.readContext);
  assertPredicates(value.predicates);
  const targets = value.targets;
  if (
    targets !== undefined &&
    (!mergeObject(targets) ||
      !(
        targets.primaryId === null ||
        (typeof targets.primaryId === "string" && isPortableIdentityText(targets.primaryId))
      ) ||
      !Array.isArray(targets.ownerIds) ||
      targets.ownerIds.some((id) => typeof id !== "string" || !isPortableIdentityText(id)) ||
      (targets.roles !== undefined &&
        (!mergeObject(targets.roles) ||
          Object.values(targets.roles).some(
            (id) => id !== null && (typeof id !== "string" || !isPortableIdentityText(id)),
          ))))
  ) {
    throw new RelayError("REPLICATION_FORMAT", replicationMessages.format, 2, {
      path: "transition.targets",
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
 * Проверяет causal guards до обращения к sourceChangesetId и сравнения переносимых версий.
 */
function assertReadContext(value: unknown): void {
  if (!Array.isArray(value)) {
    throw new RelayError("REPLICATION_FORMAT", replicationMessages.format, 2);
  }
  for (const entry of value) {
    if (
      !mergeObject(entry) ||
      typeof entry.id !== "string" ||
      !["existence", "content"].includes(String(entry.kind)) ||
      !isPortableIdentityText(entry.id) ||
      !(
        entry.version === null ||
        (typeof entry.version === "string" && /^[a-f0-9]{64}$/.test(entry.version))
      ) ||
      !(
        entry.sourceChangesetId === null ||
        (typeof entry.sourceChangesetId === "string" &&
          isPortableIdentityText(entry.sourceChangesetId))
      ) ||
      (entry.logicalDigest !== undefined &&
        (typeof entry.logicalDigest !== "string" || !/^[a-f0-9]{64}$/.test(entry.logicalDigest)))
    ) {
      throw new RelayError("REPLICATION_FORMAT", replicationMessages.format, 2, {
        path: "readContext",
      });
    }
  }
}

/**
 * Проверяет безопасную логическую форму предикатов, не интерпретируя её как SQL/команду пользователя.
 */
function assertPredicates(value: unknown): void {
  if (value === undefined) {
    return;
  }
  if (!Array.isArray(value)) {
    throw new RelayError("REPLICATION_FORMAT", replicationMessages.format, 2);
  }
  for (const predicate of value) {
    if (
      !mergeObject(predicate) ||
      !mergeObject(predicate.selector) ||
      !Array.isArray(predicate.records) ||
      !(predicate.present === null || typeof predicate.present === "boolean") ||
      predicate.records.some(
        (entry) =>
          !mergeObject(entry) ||
          typeof entry.id !== "string" ||
          !isPortableIdentityText(entry.id) ||
          !(
            entry.version === null ||
            (typeof entry.version === "string" && /^[a-f0-9]{64}$/.test(entry.version))
          ),
      )
    ) {
      throw new RelayError("REPLICATION_FORMAT", replicationMessages.format, 2, {
        path: "predicates",
      });
    }
    const selector = predicate.selector;
    const fields: Readonly<Record<string, readonly string[]>> = {
      entity: ["ref"],
      identities: [],
      records: [],
      virtual: ["ref", "entityKind"],
      field: ["entityKind", "field", "value"],
      kind: ["entityKind"],
      "field-set": ["entityKind", "field"],
      "array-item": ["entityKind", "arrayField", "itemField", "value"],
      "task-graph": [],
      memberships: ["taskId"],
      "address-state": ["ref"],
      receipt: ["operationKey"],
    };
    const required = typeof selector.kind === "string" ? fields[selector.kind] : undefined;
    if (
      required === undefined ||
      required.some((field) => typeof selector[field] !== "string") ||
      (selector.entityKind !== undefined && !isEntityKind(selector.entityKind)) ||
      (selector.semantic !== undefined &&
        selector.semantic !== "existence" &&
        selector.semantic !== "content") ||
      (selector.kind === "identities" &&
        (!Array.isArray(selector.refs) || selector.refs.some((ref) => typeof ref !== "string"))) ||
      (selector.kind === "records" &&
        (!Array.isArray(selector.ids) || selector.ids.some((id) => typeof id !== "string")))
    ) {
      throw new RelayError("REPLICATION_FORMAT", replicationMessages.format, 2, {
        path: "predicate.selector",
      });
    }
    if (
      selector.kind === "field-set" &&
      (!Array.isArray(selector.values) ||
        selector.values.some((value) => typeof value !== "string"))
    ) {
      throw new RelayError("REPLICATION_FORMAT", replicationMessages.format, 2, {
        path: "predicate.selector.values",
      });
    }
  }
}

/**
 * Переиспользует общую проверку переносимых адресов, comments и исторических receipts без final doctor.
 */
function assertEffectJournals(value: Record<string, unknown>, projectId: string): void {
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
  value: Record<string, unknown>,
  normalized: boolean,
  immediateParents = true,
): void {
  for (const field of ["entities", "addresses", "comments", "receipts"]) {
    if (!Array.isArray(value[field])) {
      throw new RelayError("REPLICATION_FORMAT", replicationMessages.format, 2, {
        path: `effects.${field}`,
      });
    }
  }
  for (const change of value.entities as unknown[]) {
    if (!mergeObject(change) || typeof change.id !== "string") {
      throw new RelayError("REPLICATION_FORMAT", replicationMessages.format, 2);
    }
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
      mergeObject(change.before) &&
      mergeObject(change.after) &&
      change.before.version !== change.after.version &&
      (!Array.isArray(change.after.parents) ||
        !change.after.parents.includes(change.before.version))
    ) {
      throw new RelayError("REPLICATION_FORMAT", replicationMessages.format, 2, {
        path: "effects.entity.parents",
      });
    }
  }
  if (normalized || value.components !== undefined) {
    if (!Array.isArray(value.components)) {
      throw new RelayError("REPLICATION_FORMAT", replicationMessages.format, 2);
    }
    for (const part of value.components) {
      if (!mergeObject(part)) {
        throw new RelayError("REPLICATION_FORMAT", replicationMessages.format, 2);
      }
      assertComponents([part.after]);
      if (part.before !== null) {
        assertComponents([part.before]);
      }
      const component = part as unknown as ReplicationTransition["components"][number];
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
