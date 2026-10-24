import {
  RelayError,
  isEntityKind,
  type ComponentKind,
  type EntityKind,
  type PortableProjectSnapshot,
  type ProjectEntity,
  type ReplicationChangeset,
  type ReplicationTransition,
} from "@relay/contracts";
import { batchActions } from "../batch/batch-catalog";
import { replicationMessages } from "./replication.messages";
import type { ReplicationIndex } from "./snapshot.types";
import type { NamedTransitionTargets } from "./transition-targets.types";

const primaryKinds: Readonly<Record<string, EntityKind>> = {
  plan: "work-plan",
  session: "work-session",
  checkpoint: "work-checkpoint",
};

/**
 * Отклоняет неполное доказательство роли до replay, не подменяя его эвристикой первого read.
 */
function invalidTargets(): never {
  throw new RelayError("REPLICATION_FORMAT", replicationMessages.format, 2, {
    path: "transition.targets",
  });
}

/**
 * Требует одну обязательную адресную роль, включая согласованность допустимых синонимов ввода.
 */
function requiredRole(targets: NamedTransitionTargets, ...names: readonly string[]): string {
  const values = names.map((name) => targets.roles[name]).filter((value) => value !== undefined);
  const value = values[0];
  if (typeof value !== "string" || !value || values.some((entry) => entry !== value)) {
    invalidTargets();
  }
  return value;
}

/**
 * Проверяет обязательные primary/owners/roles исходной именованной команды по каталогу.
 * Даже no-op обязан нести цель; неизвестное имя не получает полномочий legacy atomic.
 * Форму строк и контейнеров проверяет внешний decoder до этого вызова.
 */
export function assertNamedTransitionTargets(step: ReplicationTransition): NamedTransitionTargets {
  const action = batchActions.get(step.command);
  const targets = step.targets;
  if (
    action === undefined ||
    targets === undefined ||
    targets.primaryId === null ||
    !targets.primaryId ||
    targets.ownerIds.length === 0 ||
    targets.ownerIds.some((id) => !id) ||
    new Set(targets.ownerIds).size !== targets.ownerIds.length ||
    targets.roles === undefined
  ) {
    invalidTargets();
  }
  const named: NamedTransitionTargets = {
    ...targets,
    primaryId: targets.primaryId,
    roles: targets.roles,
  };
  if (action.description.ref === "required") {
    requiredRole(named, "ref");
  }
  let primaryRole: string | undefined;
  if (step.command.startsWith("task.criterion.") && step.command !== "task.criterion.add") {
    primaryRole = requiredRole(named, "input.id", "input.criterionId");
  } else if (
    step.command.startsWith("document.section.") &&
    step.command !== "document.section.create"
  ) {
    primaryRole = requiredRole(named, "input.id");
  } else if (
    step.command.startsWith("plan.stage.") &&
    !["plan.stage.create", "plan.stage.task.transfer"].includes(step.command)
  ) {
    primaryRole = requiredRole(named, "input.stageId");
  }
  if (primaryRole !== undefined && primaryRole !== named.primaryId) {
    invalidTargets();
  }
  if (step.command.startsWith("plan.stage.task.")) {
    requiredRole(named, "input.task");
    if (step.command === "plan.stage.task.transfer") {
      requiredRole(named, "input.targetPlan");
      requiredRole(named, "input.targetStage");
    }
  }
  if (
    [
      "document.link",
      "document.unlink",
      "task.link",
      "task.unlink",
      "task.dependency.add",
      "task.dependency.remove",
    ].includes(step.command)
  ) {
    requiredRole(named, "input.target");
  }
  if (step.command === "task.parent.set") {
    requiredRole(named, "input.parent");
  }
  if (step.command === "scenario.create") {
    requiredRole(named, "input.feature", "input.featureId");
  }
  if (step.command === "implementation.create") {
    requiredRole(named, "input.application", "input.applicationId");
    requiredRole(named, "input.target");
  }
  return named;
}

/**
 * Требует каноническую сущность нужного вида, а не заявленный источник или predicate.records.
 */
function targetEntity(index: ReplicationIndex, id: string, kind: EntityKind): ProjectEntity {
  const entity = index.byId.get(id);
  if (entity === undefined || entity.kind !== kind) {
    invalidTargets();
  }
  return entity;
}

/**
 * Связывает scoped primary с настоящим владельцем части; tombstone допустим только как эффект снятия.
 */
function assertNestedPrimary(
  step: ReplicationTransition,
  previous: PortableProjectSnapshot,
  ownerId: string,
  kind: ComponentKind,
  primaryId: string,
): void {
  const change = step.components.find(
    (entry) =>
      entry.after.ownerId === ownerId && entry.after.kind === kind && entry.after.id === primaryId,
  );
  const current = (previous.components ?? []).find(
    (part) =>
      part.ownerId === ownerId && part.kind === kind && part.id === primaryId && !part.deleted,
  );
  if (change === undefined && current === undefined) {
    invalidTargets();
  }
  if (
    ["task.criterion.add", "document.section.create", "plan.stage.create"].includes(step.command) &&
    (change?.before !== null || change.after.deleted)
  ) {
    invalidTargets();
  }
}

/**
 * Связывает вложенный результат с его владельцем; null обозначает самостоятельную сущность.
 */
function nestedOwner(
  step: ReplicationTransition,
  targets: NamedTransitionTargets,
  previous: PortableProjectSnapshot,
  next: ReplicationIndex,
): string | null {
  const command = step.command;
  if (command.startsWith("document.section.")) {
    targetEntity(next, previous.projectId, "project");
    assertNestedPrimary(step, previous, previous.projectId, "document-section", targets.primaryId);
    return previous.projectId;
  }
  if (
    command.startsWith("task.criterion.") ||
    command === "task.comment.add" ||
    (command.startsWith("plan.stage.") && command !== "plan.stage.task.transfer")
  ) {
    const ownerId = requiredRole(targets, "ref");
    targetEntity(next, ownerId, command.startsWith("plan.") ? "work-plan" : "task");
    if (command === "task.comment.add") {
      if (
        step.comments.length !== 1 ||
        step.comments[0]?.taskId !== ownerId ||
        step.comments[0]?.comment.id !== targets.primaryId
      ) {
        invalidTargets();
      }
    } else {
      assertNestedPrimary(
        step,
        previous,
        ownerId,
        command.startsWith("plan.") ? "plan-stage" : "task-criterion",
        targets.primaryId,
      );
    }
    return ownerId;
  }
  return null;
}

/**
 * Определяет владельца самостоятельного результата по canonical данным, включая fork и checkpoint.
 * Создание обязано иметь исходный new-entity effect; product.create заполняет существующий singleton.
 */
function primaryOwner(
  step: ReplicationTransition,
  targets: NamedTransitionTargets,
  previous: PortableProjectSnapshot,
  next: ReplicationIndex,
): string {
  const nested = nestedOwner(step, targets, previous, next);
  if (nested !== null) {
    return nested;
  }
  const command = step.command;
  const prefix = command.split(".")[0];
  const kind = primaryKinds[prefix ?? ""] ?? prefix;
  if (!isEntityKind(kind)) {
    invalidTargets();
  }
  const primary = targetEntity(next, targets.primaryId, kind);
  const creates =
    (command.endsWith(".create") && command !== "product.create") ||
    ["session.start", "session.fork"].includes(command) ||
    command.startsWith("checkpoint.");
  if (creates && step.entities.find((entry) => entry.id === primary.id)?.before !== null) {
    invalidTargets();
  }
  if (
    command === "scenario.create" &&
    primary.kind === "scenario" &&
    primary.data.featureId !== requiredRole(targets, "input.feature", "input.featureId")
  ) {
    invalidTargets();
  }
  if (command === "implementation.create" && primary.kind === "implementation") {
    if (
      primary.data.applicationId !==
        requiredRole(targets, "input.application", "input.applicationId") ||
      primary.data.targetId !== requiredRole(targets, "input.target")
    ) {
      invalidTargets();
    }
    targetEntity(next, primary.data.applicationId, "application");
    return primary.data.applicationId;
  }
  if (command === "session.fork" && primary.kind === "work-session") {
    if (
      primary.data.parentSessionId === null ||
      primary.data.originCheckpointId !== requiredRole(targets, "ref")
    ) {
      invalidTargets();
    }
    targetEntity(next, primary.data.parentSessionId, "work-session");
    return primary.data.parentSessionId;
  }
  if (primary.kind === "work-checkpoint") {
    targetEntity(next, primary.data.sessionId, "work-session");
    const ref = requiredRole(targets, "ref");
    if (
      (command === "checkpoint.open" ? primary.data.sessionId : primary.data.intentId) !== ref ||
      targets.roles.session !== primary.data.sessionId
    ) {
      invalidTargets();
    }
    return primary.data.sessionId;
  }
  if (targets.roles.ref !== undefined && targets.roles.ref !== primary.id) {
    invalidTargets();
  }
  if (primary.kind === "project" && primary.id !== previous.projectId) {
    invalidTargets();
  }
  return primary.id;
}

/**
 * Проверяет поддержку owner исходным адресным чтением; широкая выборка графа не выбирает цель команды.
 * Predicate не является authority: он связывается с guard и before, а no-op сверяется с actual boundary.
 */
function assertOwnerRead(step: ReplicationTransition, ownerId: string): void {
  const effect = step.entities.find((entry) => entry.id === ownerId);
  if (effect?.before === null) {
    return;
  }
  const semantic = step.command === "task.comment.add" ? "existence" : "content";
  const guard = step.readContext.find((entry) => entry.id === ownerId && entry.kind === semantic);
  if (
    guard === undefined ||
    (semantic === "content" && guard.version === null) ||
    (effect?.before != null && effect.before.version !== guard.version)
  ) {
    invalidTargets();
  }
  const predicate = step.predicates?.find(
    ({ selector, records }) =>
      selector.kind === "entity" &&
      selector.ref === ownerId &&
      (selector.semantic ?? "content") === semantic &&
      records.length === 1 &&
      records[0]?.id === ownerId &&
      records[0].version === guard.version,
  );
  if (predicate === undefined) {
    invalidTargets();
  }
}

/**
 * Проверяет достаточность целей на реальном canonical boundary до предметных validators.
 * Возвращает всех явных владельцев, включая неизменённого участника составной команды.
 * Legacy/технический переход не получает новых прав named-команды и проверяется консервативно отдельно.
 */
export function validateTransitionTargets(
  step: ReplicationTransition | undefined,
  change: ReplicationChangeset,
  previous: PortableProjectSnapshot,
  next: ReplicationIndex,
): readonly string[] {
  if (
    step === undefined ||
    ["baseline", "storage.atomic", "legacy.atomic"].includes(step.command)
  ) {
    return [];
  }
  const targets = assertNamedTransitionTargets(step);
  const ownerId = primaryOwner(step, targets, previous, next);
  const owners = new Set([ownerId]);
  if (step.command === "plan.stage.task.transfer") {
    const target = requiredRole(targets, "input.targetPlan");
    targetEntity(next, target, "work-plan");
    owners.add(target);
    if (targets.roles.target !== target) {
      invalidTargets();
    }
  }
  if (owners.size !== targets.ownerIds.length || targets.ownerIds.some((id) => !owners.has(id))) {
    invalidTargets();
  }
  for (const id of owners) {
    assertOwnerRead(step, id);
  }
  const allowed = new Set([...owners, targets.primaryId]);
  const primary = next.byId.get(targets.primaryId);
  if (primary?.kind === "application") {
    if (["application.create", "application.update"].includes(step.command)) {
      allowed.add(primary.data.boardId);
      if (step.command === "application.create" && targets.roles.board !== primary.data.boardId) {
        invalidTargets();
      }
    }
    if (step.command === "application.participation.replace") {
      for (const entity of next.byId.values()) {
        if (entity.kind === "implementation" && entity.data.applicationId === primary.id) {
          allowed.add(entity.id);
        }
      }
    }
  }
  if (
    change.entities.some((entry) => !allowed.has(entry.id)) ||
    step.comments.some((entry) => !owners.has(entry.taskId))
  ) {
    invalidTargets();
  }
  return [...owners];
}
