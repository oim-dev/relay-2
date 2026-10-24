import {
  RelayError,
  type HistoryCheckpoint,
  type HistorySession,
  type PortableProjectSnapshot,
  type ReplicationChangeset,
  type ReplicationTransition,
  type TaskRecord,
} from "@relay/contracts";
import { canonicalJson, portableEntity, replicationFingerprint } from "@relay/storage";
import { decodeHistoryCheckpoint, decodeHistorySession } from "../history/history-data";
import { assertHistoryTransition } from "../history/history-transition";
import { decodeKnowledge, isKnowledgeKind } from "../knowledge/knowledge-data";
import { assertKnowledgeTransition } from "../knowledge/knowledge-transition";
import { requireActiveDocumentSection } from "../knowledge/document-sections";
import { relationTarget } from "../knowledge/knowledge-relations";
import { decodePlanning } from "../planning/planning-data";
import { assertPlanningTransition } from "../planning/planning-transition";
import { TASK_CRITERION_FIELDS } from "../tasks/task-constants";
import { taskRecord } from "../tasks/task-data";
import { assertTaskTransition } from "../tasks/task-transition";
import { replicationMessages } from "./replication.messages";
import type { ReplicationIndex } from "./snapshot.types";
import { snapshotRecords } from "./snapshot-records";
import type { PlanningRoleContext } from "./transition-validation.types";
import { validateTransitionTargets } from "./transition-targets";

/**
 * Не переносит отметку выполнения на конкурентно изменённый текст, которого автор не видел.
 * Это трёхстороннее правило согласования; допустимость обычного task transition проверяет Tasks.
 */
function validateCriteriaTransition(
  original: TaskRecord | null,
  local: TaskRecord,
  candidate: TaskRecord,
): void {
  const before = new Map(original?.data.acceptanceCriteria.map((entry) => [entry.id, entry]) ?? []);
  const proposed = new Map(local.data.acceptanceCriteria.map((entry) => [entry.id, entry]));
  for (const criterion of candidate.data.acceptanceCriteria) {
    if (!criterion.completed) {
      continue;
    }
    const was = before.get(criterion.id);
    const own = proposed.get(criterion.id);
    if (own === undefined) {
      continue;
    }
    const ownTextChanged =
      was !== undefined && TASK_CRITERION_FIELDS.some((field) => was[field] !== own[field]);
    const concurrentTextChanged = TASK_CRITERION_FIELDS.some(
      (field) => own[field] !== criterion[field],
    );
    if (
      (ownTextChanged && !own.completed) ||
      (own.completed && was?.completed !== true && concurrentTextChanged)
    ) {
      throw new RelayError("REPLICATION_CONFLICT", replicationMessages.conflict, 4, {
        criterionId: criterion.id,
      });
    }
  }
}

/**
 * Проверяет whole-command boundary через общих чистых владельцев предметных правил.
 * Не исполняет команды, не выдаёт ID/время и не переоткрывает исторически закрытые записи.
 */
export function validateChangesetTransition(
  changeset: ReplicationChangeset,
  previous: PortableProjectSnapshot,
  next: ReplicationIndex,
  transition?: ReplicationTransition,
): void {
  const records = snapshotRecords(previous);
  const before = new Map(records.map((record) => [record.id, record]));
  const progress = new Map(next.tasks.map((task) => [task.id, next.graph.progress(task.id)]));
  const beforeSessions = records
    .filter((record) => record.kind === "work-session")
    .map(decodeHistorySession);
  const beforeCheckpoints = records
    .filter((record) => record.kind === "work-checkpoint")
    .map(decodeHistoryCheckpoint);
  const sourceOperation = transition?.command;
  const operation =
    sourceOperation === undefined ||
    ["storage.atomic", "legacy.atomic", "baseline"].includes(sourceOperation)
      ? "replication"
      : sourceOperation;
  const noopOwners = new Set(
    validateTransitionTargets(transition, changeset, previous, next).filter(
      (id) =>
        !changeset.entities.some((entry) => entry.id === id) &&
        transition?.command !== "task.comment.add",
    ),
  );
  const changes = [...changeset.entities];
  for (const id of noopOwners) {
    const current = before.get(id);
    const guard = transition?.readContext.find(
      (entry) => entry.id === id && entry.kind === "content",
    );
    const version = previous.entities.find((entry) => entry.record.id === id)?.version;
    if (
      current === undefined ||
      guard === undefined ||
      (guard.logicalDigest !== undefined
        ? guard.logicalDigest !== replicationFingerprint(portableEntity(current).record)
        : guard.version !== version)
    ) {
      throw new RelayError("REPLICATION_CONFLICT", replicationMessages.conflict, 4, {
        id,
        operation,
        reason: "noop-context",
      });
    }
    if (!changes.some((entry) => entry.id === id)) {
      const entity = portableEntity(current);
      changes.push({ id, before: entity, after: entity });
    }
  }
  for (const change of changes) {
    const current = before.get(change.id);
    const candidate = next.byId.get(change.id);
    if (candidate === undefined || change.after === null) {
      throw new RelayError("REPLICATION_IMMUTABLE", replicationMessages.immutable, 4);
    }
    if (
      current !== undefined &&
      (current.kind !== candidate.kind ||
        current.createdAt !== candidate.createdAt ||
        current.createdBy !== candidate.createdBy)
    ) {
      throw new RelayError("REPLICATION_IMMUTABLE", replicationMessages.immutable, 4);
    }
    const actor = transition?.actor ?? candidate.updatedBy;
    if (isKnowledgeKind(candidate.kind)) {
      const sectionId = transition?.targets?.primaryId;
      const beforeSectionId = transition?.targets?.roles?.["input.before"];
      assertKnowledgeTransition(current ?? null, candidate, {
        operation,
        ...(operation.startsWith("document.section.") && sectionId != null ? { sectionId } : {}),
        ...(beforeSectionId === undefined ? {} : { beforeSectionId }),
      });
    }
    if (candidate.kind === "task") {
      const own = taskRecord({
        ...change.after.record,
        revision: 1,
        data: { ...change.after.record.data, comments: [] },
      });
      const original =
        change.before === null
          ? null
          : taskRecord({
              ...change.before.record,
              revision: 1,
              data: { ...change.before.record.data, comments: [] },
            });
      validateCriteriaTransition(original, own, candidate);
      const board = next.byId.get(candidate.data.boardId);
      const targets = candidate.data.targets
        .map((id) => next.byId.get(id))
        .filter(
          (target) =>
            target?.kind === "feature" ||
            target?.kind === "scenario" ||
            target?.kind === "implementation",
        );
      if (board?.kind === "board") {
        assertTaskTransition(
          current === undefined
            ? null
            : taskRecord({ ...current, data: { ...current.data, comments: [] } }),
          candidate,
          {
            operation,
            graph: next.graph,
            board,
            targets,
            ...(operation === "replication" ? {} : { actor }),
            ...(transition?.timestamp === undefined || operation === "replication"
              ? {}
              : { timestamp: transition.timestamp }),
            ...(operation.startsWith("task.criterion.") && transition?.targets?.primaryId != null
              ? {
                  criterionId:
                    transition.targets.roles?.["input.id"] ?? transition.targets.primaryId,
                }
              : {}),
          },
        );
      }
    }
    if (candidate.kind === "document") {
      if (
        current === undefined ||
        (current.data.sectionId ?? null) !== candidate.data.sectionId ||
        Object.hasOwn(transition?.targets?.roles ?? {}, "input.sectionId")
      ) {
        requireActiveDocumentSection(candidate.data.sectionId, next.sections);
      }
      const retained = new Set(
        current?.kind === "document"
          ? decodeKnowledge(current, "document").data.relations.map(
              (entry) => `${entry.target.id}:${entry.type}`,
            )
          : [],
      );
      for (const relation of candidate.data.relations) {
        const target = next.byId.get(relation.target.id);
        if (target !== undefined) {
          relationTarget(
            target,
            candidate.id,
            retained.has(`${relation.target.id}:${relation.type}`),
          );
        }
      }
    }
    // Чужое позднее reopening не является новой попыткой complete/publish старого владельца.
    const unchanged =
      current !== undefined &&
      portableEntity(current).version === portableEntity(candidate).version;
    if (
      (candidate.kind === "work-plan" || candidate.kind === "release") &&
      (!unchanged || noopOwners.has(candidate.id) || changeset.mode === "mutation")
    ) {
      assertPlanningTransition(
        current === undefined ? null : decodePlanning(current, previous.projectId),
        candidate,
        {
          operation,
          actor,
          plans: next.plans,
          taskProgress: progress,
          memberships: next.plans.filter((plan) => plan.id !== candidate.id),
          taskIds: new Set(next.tasks.map((task) => task.id)),
          scope: [...next.byId.values()].map(({ id, key, kind }) => ({ id, key, kind })),
          ...planningRoleContext(transition),
        },
      );
    }
    if (candidate.kind === "work-session" && change.before?.record.kind === "work-session") {
      const original = decodeHistorySession({ ...change.before.record, revision: 1 });
      const remote = current?.kind === "work-session" ? decodeHistorySession(current) : null;
      if (
        remote !== null &&
        remote.data.currentRunId !== original.data.currentRunId &&
        canonicalJson(change.before.record.data) !== canonicalJson(change.after.record.data)
      ) {
        throw new RelayError("REPLICATION_OWNERSHIP", replicationMessages.immutable, 4);
      }
    }
    if (
      (candidate.kind === "work-session" || candidate.kind === "work-checkpoint") &&
      (!unchanged || noopOwners.has(candidate.id) || changeset.mode === "mutation")
    ) {
      let prior: HistorySession | HistoryCheckpoint | null = null;
      if (current !== undefined) {
        prior =
          current.kind === "work-session"
            ? decodeHistorySession(current)
            : decodeHistoryCheckpoint(current);
      }
      assertHistoryTransition(prior, candidate, {
        actor,
        operation,
        ...(transition?.targets?.roles?.run == null
          ? {}
          : { newRunId: transition.targets.roles.run }),
        beforeSessions,
        afterSessions: next.sessions,
        beforeCheckpoints,
        afterCheckpoints: next.checkpoints,
      });
    }
  }
}

/**
 * Передаёт владельцу planning только явные разрешённые роли; порядок reads не используется.
 */
function planningRoleContext(transition: ReplicationTransition | undefined): PlanningRoleContext {
  const roles = transition?.targets?.roles ?? {};
  const stageId =
    roles["input.stageId"] ??
    (transition !== undefined &&
    ["plan.stage.create", "plan.stage.update", "plan.stage.move", "plan.stage.remove"].includes(
      transition.command,
    )
      ? transition.targets?.primaryId
      : undefined);
  const taskId = roles["input.task"];
  const sourcePlanId = roles.ref;
  const targetPlanId = roles["input.targetPlan"];
  const targetStageId = roles["input.targetStage"];
  const beforeStageId = roles["input.before"];
  return {
    ...(stageId == null ? {} : { stageId }),
    ...(taskId == null ? {} : { taskId }),
    ...(sourcePlanId == null ? {} : { sourcePlanId }),
    ...(targetPlanId == null ? {} : { targetPlanId }),
    ...(targetStageId == null ? {} : { targetStageId }),
    ...(beforeStageId === undefined ? {} : { beforeStageId }),
  };
}
