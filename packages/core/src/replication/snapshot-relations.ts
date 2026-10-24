import { RelayError, type KnowledgeRecord, type ProjectEntity } from "@relay/contracts";
import { ensureTaskTargets } from "../tasks/task-rules";
import { openPlan } from "../planning/planning-rules";
import {
  checkHistoryAcceptance,
  checkHistoryChildrenClosure,
  openHistoryIntents,
} from "../history/history-rules";
import { replicationMessages } from "./replication.messages";
import type { ReplicationIndex } from "./snapshot.types";

/**
 * Проверяет встречные составы, FI/SI, уникальные назначения и историю по общим индексам.
 */
export function validateSnapshotRelations(index: ReplicationIndex): void {
  const memberships = new Set<string>();
  const participation = new Set<string>();
  const activeFeatures = new Set<string>();
  const implementations: KnowledgeRecord<"implementation">[] = [];
  const virtual = new Set<string>();
  for (const record of index.byId.values()) {
    if (record.kind === "board" || record.kind === "application") {
      for (const field of ["slug", "prefix"] as const) {
        const address = `${record.kind}:${field}:${record.data[field]}`;
        if (virtual.has(address)) {
          throw new RelayError("REPLICATION_INVARIANT", replicationMessages.address, 4);
        }
        virtual.add(address);
      }
    }
    if (record.kind === "implementation") {
      implementations.push(record);
      const address = `${record.data.applicationId}:${record.data.targetId}`;
      if (participation.has(address)) {
        throw new RelayError("REPLICATION_INVARIANT", replicationMessages.invariant, 4);
      }
      participation.add(address);
      if (record.data.active && record.data.targetKind === "feature") {
        activeFeatures.add(address);
      }
      const application = index.byId.get(record.data.applicationId);
      if (
        application?.kind !== "application" ||
        application.data.implementationIds.includes(record.id) !== record.data.active
      ) {
        throw new RelayError("REPLICATION_INVARIANT", replicationMessages.invariant, 4);
      }
      if (record.data.targetKind === "scenario") {
        const scenario = index.byId.get(record.data.targetId);
        if (scenario?.kind !== "scenario" || scenario.data.featureId !== record.data.featureId) {
          throw new RelayError("REPLICATION_INVARIANT", replicationMessages.invariant, 4);
        }
      }
    }
    if (record.kind === "application") {
      for (const id of record.data.implementationIds) {
        const implementation = index.byId.get(id);
        if (
          implementation?.kind !== "implementation" ||
          implementation.data.applicationId !== record.id ||
          !implementation.data.active
        ) {
          throw new RelayError("REPLICATION_INVARIANT", replicationMessages.invariant, 4);
        }
      }
    }
  }
  for (const record of implementations) {
    if (
      record.data.active &&
      record.data.targetKind === "scenario" &&
      !activeFeatures.has(`${record.data.applicationId}:${record.data.featureId}`)
    ) {
      throw new RelayError("REPLICATION_INVARIANT", replicationMessages.invariant, 4);
    }
  }
  for (const task of index.tasks) {
    const board = index.byId.get(task.data.boardId);
    if (board?.kind !== "board") {
      throw new RelayError("REPLICATION_INVARIANT", replicationMessages.invariant, 4);
    }
    const targets = task.data.targets
      .map((id) => index.byId.get(id))
      .filter(
        (record) =>
          record?.kind === "feature" ||
          record?.kind === "scenario" ||
          record?.kind === "implementation",
      );
    if (targets.length !== task.data.targets.length) {
      throw new RelayError("REPLICATION_INVARIANT", replicationMessages.invariant, 4);
    }
    ensureTaskTargets(targets, board, task.data.targets);
  }
  for (const plan of index.plans) {
    if (!openPlan(plan)) {
      continue;
    }
    for (const stage of plan.data.stages) {
      for (const id of stage.taskIds) {
        if (memberships.has(id)) {
          throw new RelayError("MEMBERSHIP_CONFLICT", replicationMessages.invariant, 4, {
            taskId: id,
          });
        }
        memberships.add(id);
      }
    }
  }
  const sequences = new Set<string>();
  const closedIntents = new Set<string>();
  for (const checkpoint of index.checkpoints) {
    const session = index.byId.get(checkpoint.data.sessionId);
    if (
      session?.kind !== "work-session" ||
      !session.data.runs.some(
        (run) => run.id === checkpoint.data.runId && run.actor === checkpoint.data.actor,
      )
    ) {
      throw new RelayError("REPLICATION_INVARIANT", replicationMessages.invariant, 4);
    }
    const sequence = `${session.id}:${checkpoint.data.sequence}`;
    if (sequences.has(sequence)) {
      throw new RelayError("REPLICATION_INVARIANT", replicationMessages.invariant, 4);
    }
    sequences.add(sequence);
    if (checkpoint.data.kind === "result" || checkpoint.data.kind === "cancel") {
      if (checkpoint.data.intentId === null || closedIntents.has(checkpoint.data.intentId)) {
        throw new RelayError("REPLICATION_INVARIANT", replicationMessages.invariant, 4);
      }
      closedIntents.add(checkpoint.data.intentId);
    }
    if (checkpoint.data.intentId !== null) {
      const intent = index.byId.get(checkpoint.data.intentId);
      if (
        intent?.kind !== "work-checkpoint" ||
        intent.data.kind !== "intent" ||
        intent.data.sessionId !== session.id ||
        intent.data.sequence >= checkpoint.data.sequence
      ) {
        throw new RelayError("REPLICATION_INVARIANT", replicationMessages.invariant, 4);
      }
      const accepted = checkpoint.data.acceptedSessionIds
        .map((id) => index.byId.get(id))
        .filter((entry) => entry?.kind === "work-session");
      checkHistoryAcceptance(session.id, checkpoint.data.intentId, accepted);
    }
  }
  // Цепочки родителей используют уже построенный byId, без повторного построения графа в цикле.
  const checked = new Set<string>();
  for (const session of index.sessions) {
    if (session.data.parentSessionId !== null) {
      const parent = index.byId.get(session.data.parentSessionId);
      const intent =
        session.data.originCheckpointId === null
          ? undefined
          : index.byId.get(session.data.originCheckpointId);
      if (
        parent?.kind !== "work-session" ||
        intent?.kind !== "work-checkpoint" ||
        intent.data.kind !== "intent" ||
        intent.data.sessionId !== parent.id ||
        !parent.data.runs.some((run) => run.id === session.data.createdByRunId)
      ) {
        throw new RelayError("REPLICATION_INVARIANT", replicationMessages.invariant, 4);
      }
    }
    if (session.data.status === "completed" || session.data.status === "cancelled") {
      if (
        openHistoryIntents(index.checkpoints.filter((entry) => entry.data.sessionId === session.id))
          .length !== 0
      ) {
        throw new RelayError("REPLICATION_INVARIANT", replicationMessages.invariant, 4);
      }
      checkHistoryChildrenClosure(session.id, null, [], index.sessions, index.checkpoints);
    }
    const chain = new Set<string>();
    let cursor: typeof session | undefined = session;
    while (cursor !== undefined && !checked.has(cursor.id)) {
      if (chain.has(cursor.id)) {
        throw new RelayError("REPLICATION_INVARIANT", replicationMessages.invariant, 4);
      }
      chain.add(cursor.id);
      const parent: ProjectEntity | undefined =
        cursor.data.parentSessionId === null
          ? undefined
          : index.byId.get(cursor.data.parentSessionId);
      cursor = parent?.kind === "work-session" ? parent : undefined;
    }
    for (const id of chain) {
      checked.add(id);
    }
  }
}
