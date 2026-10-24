import {
  RelayError,
  validateActor,
  isPortableIdentityText,
  type EntityRecord,
  type PortableProjectSnapshot,
  type ProjectEntity,
} from "@relay/contracts";
import { decodeHistoryCheckpoint, decodeHistorySession } from "../history/history-data";
import { decodeKnowledge } from "../knowledge/knowledge-data";
import { indexDocumentSections, projectDocumentSection } from "../knowledge/document-sections";
import { decodePlanning } from "../planning/planning-data";
import { taskGraphNode, taskRecord } from "../tasks/task-data";
import { TaskGraph } from "../tasks/task-graph";
import { TASK_LIMITS } from "../tasks/task-constants";
import { taskTextViolation } from "../tasks/task-text";
import {
  indexIntegrityRecords,
  inspectEntityReferences,
} from "../queries/queries-doctor-references";
import { decodeBatchReceipt } from "../batch/batch-receipt";
import { mergeObject } from "./record-merge";
import { replicationMessages } from "./replication.messages";
import { validateSnapshotRelations } from "./snapshot-relations";
import type { ReplicationIndex } from "./snapshot.types";
import { snapshotRecords } from "./snapshot-records";
import { assertComponents, validateComponentOwners } from "./component-validation";
import { assertPortableEntity } from "./portable-entity-validation";

/**
 * Отклоняет неверный переносимый формат с точным путём без исправления входа.
 */
function invalidSnapshot(path: string): never {
  throw new RelayError("REPLICATION_FORMAT", replicationMessages.format, 2, { path });
}

/**
 * Не позволяет принять поля, которые физическое хранилище не сохранит при round-trip.
 */
function assertFields(
  value: Record<string, unknown>,
  fields: readonly string[],
  path: string,
): void {
  if (Object.keys(value).some((field) => !fields.includes(field))) {
    invalidSnapshot(path);
  }
}

/**
 * Проверяет корневую форму и технические поля недоверенного JSON перед предметными декодерами.
 * Утверждение типа следует полному обходу переносимых полей, включая метаданные журнала.
 */
export function assertSnapshot(value: unknown): asserts value is PortableProjectSnapshot {
  if (
    !mergeObject(value) ||
    value.formatVersion !== 1 ||
    typeof value.projectId !== "string" ||
    !value.projectId
  ) {
    invalidSnapshot("snapshot");
  }
  if (!isPortableIdentityText(value.projectId)) {
    invalidSnapshot("projectId.utf16");
  }
  assertFields(
    value,
    [
      "formatVersion",
      "modelVersion",
      "projectId",
      "entities",
      "components",
      "addresses",
      "comments",
      "receipts",
      "confirmations",
      "publication",
    ],
    "snapshot.fields",
  );
  for (const field of ["entities", "addresses", "comments", "receipts", "confirmations"] as const) {
    if (!Array.isArray(value[field])) {
      invalidSnapshot(field);
    }
  }
  if (value.modelVersion !== undefined && value.modelVersion !== 2) {
    invalidSnapshot("modelVersion");
  }
  if (value.modelVersion === 2) {
    assertComponents(value.components);
  }
  for (const entry of value.entities as unknown[]) {
    assertPortableEntity(entry);
  }
  for (const entry of value.addresses as unknown[]) {
    if (
      !mergeObject(entry) ||
      typeof entry.ref !== "string" ||
      !entry.ref ||
      typeof entry.entityId !== "string"
    ) {
      invalidSnapshot("addresses");
    }
    assertFields(entry, ["ref", "entityId"], "addresses.fields");
    if (!isPortableIdentityText(entry.ref) || !isPortableIdentityText(entry.entityId)) {
      invalidSnapshot("addresses.utf16");
    }
  }
  for (const entry of value.comments as unknown[]) {
    if (
      !mergeObject(entry) ||
      typeof entry.taskId !== "string" ||
      !(entry.after === null || typeof entry.after === "string") ||
      !mergeObject(entry.comment)
    ) {
      invalidSnapshot("comments");
    }
    assertFields(entry, ["taskId", "comment", "after"], "comments.fields");
    assertFields(
      entry.comment,
      ["id", "title", "body", "createdAt", "createdBy"],
      "comment.fields",
    );
    if (
      !isPortableIdentityText(entry.taskId) ||
      (entry.after !== null && !isPortableIdentityText(entry.after))
    ) {
      invalidSnapshot("comments.utf16");
    }
    for (const field of ["id", "title", "body", "createdAt", "createdBy"]) {
      if (typeof entry.comment[field] !== "string") {
        invalidSnapshot(`comment.${field}`);
      }
    }
    if (!entry.comment.id || !Number.isFinite(Date.parse(String(entry.comment.createdAt)))) {
      invalidSnapshot("comment.metadata");
    }
    validateActor(entry.comment.createdBy);
    if (
      ![entry.comment.id, entry.comment.createdAt, entry.comment.createdBy].every(
        (field) => typeof field === "string" && isPortableIdentityText(field),
      )
    ) {
      invalidSnapshot("comment.identity.utf16");
    }
    if (
      taskTextViolation(String(entry.comment.body), TASK_LIMITS.commentBody, { required: true }) !==
        undefined ||
      taskTextViolation(String(entry.comment.title), TASK_LIMITS.commentTitle, {
        singleLine: true,
      }) !== undefined
    ) {
      invalidSnapshot("comment.text");
    }
  }
  for (const entry of value.receipts as unknown[]) {
    if (
      !mergeObject(entry) ||
      typeof entry.operationKey !== "string" ||
      typeof entry.requestJson !== "string" ||
      typeof entry.resultJson !== "string"
    ) {
      invalidSnapshot("receipts");
    }
    assertFields(entry, ["operationKey", "requestJson", "resultJson"], "receipt.fields");
    if (![entry.operationKey, entry.requestJson, entry.resultJson].every(isPortableIdentityText)) {
      invalidSnapshot("receipt.utf16");
    }
    decodeBatchReceipt(entry.resultJson, entry.operationKey, value.projectId);
    try {
      JSON.parse(entry.requestJson);
    } catch {
      invalidSnapshot("receipt.requestJson");
    }
  }
  const replicas = new Set<string>();
  for (const entry of value.confirmations as unknown[]) {
    if (
      !mergeObject(entry) ||
      typeof entry.replicaId !== "string" ||
      !entry.replicaId ||
      !Array.isArray(entry.ranges) ||
      replicas.has(entry.replicaId)
    ) {
      invalidSnapshot("confirmations");
    }
    replicas.add(entry.replicaId);
    if (!isPortableIdentityText(entry.replicaId)) {
      invalidSnapshot("replicaId.utf16");
    }
    let previous = -1;
    for (const range of entry.ranges) {
      if (
        !Array.isArray(range) ||
        range.length !== 2 ||
        !Number.isSafeInteger(range[0]) ||
        !Number.isSafeInteger(range[1]) ||
        range[0] < 1 ||
        range[1] < range[0] ||
        range[0] <= previous + 1
      ) {
        invalidSnapshot("confirmations.ranges");
      }
      previous = range[1];
    }
    if (!Array.isArray(entry.proofs)) {
      invalidSnapshot("confirmations.proofs");
    }
    const sequences = new Set<number>();
    for (const proof of entry.proofs) {
      if (
        !mergeObject(proof) ||
        typeof proof.sequence !== "number" ||
        !Number.isSafeInteger(proof.sequence) ||
        typeof proof.digest !== "string" ||
        !/^[a-f0-9]{64}$/.test(proof.digest) ||
        sequences.has(proof.sequence)
      ) {
        invalidSnapshot("confirmations.proof");
      }
      const sequence = proof.sequence;
      if (
        value.modelVersion === 2 &&
        (typeof proof.publicationId !== "string" ||
          !/^[a-f0-9]{64}$/.test(proof.publicationId) ||
          !(
            proof.resolutionId === null ||
            (typeof proof.resolutionId === "string" && /^[a-f0-9]{64}$/.test(proof.resolutionId))
          ) ||
          typeof proof.effectDigest !== "string" ||
          !/^[a-f0-9]{64}$/.test(proof.effectDigest) ||
          (proof.outcome !== "applied" && proof.outcome !== "discarded"))
      ) {
        invalidSnapshot("confirmations.publication");
      }
      if (!entry.ranges.some((range) => sequence >= range[0] && sequence <= range[1])) {
        invalidSnapshot("confirmations.proof");
      }
      sequences.add(proof.sequence);
    }
    const confirmedCount = entry.ranges.reduce(
      (total, range) => total + range[1] - range[0] + 1,
      0,
    );
    if (confirmedCount !== sequences.size) {
      invalidSnapshot("confirmations.proofs");
    }
  }
}

/**
 * Декодирует сохранённую запись без effective-замены разделов и без обращения к хранилищу.
 */
function decodeStoredRecord(
  record: EntityRecord,
  snapshot: PortableProjectSnapshot,
  comments: ReadonlyMap<string, readonly unknown[]>,
): ProjectEntity {
  switch (record.kind) {
    case "task":
      return taskRecord({
        ...record,
        data: { ...record.data, comments: comments.get(record.id) ?? [] },
      });
    case "work-plan":
    case "release":
      return decodePlanning(record, snapshot.projectId);
    case "work-session":
      return decodeHistorySession(record);
    case "work-checkpoint":
      if (record.revision !== 1) {
        invalidSnapshot("checkpoint.revision");
      }
      if (
        record.createdAt !== record.updatedAt ||
        record.createdBy !== record.updatedBy ||
        record.createdBy !== record.data.actor
      ) {
        invalidSnapshot("checkpoint.metadata");
      }
      return decodeHistoryCheckpoint(record);
    default:
      return decodeKnowledge(record, record.kind);
  }
}

/**
 * Проверяет адреса и append-only порядок журналов без сортировки по времени.
 */
function validateAddressesAndComments(snapshot: PortableProjectSnapshot): Map<string, unknown[]> {
  const entities = new Map(snapshot.entities.map((entry) => [entry.record.id, entry.record]));
  const addresses = new Map(snapshot.addresses.map((entry) => [entry.ref, entry.entityId]));
  if (entities.size !== snapshot.entities.length || addresses.size !== snapshot.addresses.length) {
    invalidSnapshot("duplicate");
  }
  for (const record of entities.values()) {
    if (addresses.get(record.id) !== record.id || addresses.get(record.key) !== record.id) {
      invalidSnapshot("addresses.owner");
    }
  }
  for (const address of snapshot.addresses) {
    if (!entities.has(address.entityId)) {
      invalidSnapshot("addresses.target");
    }
  }
  const byId = new Map(snapshot.comments.map((entry) => [entry.comment.id, entry]));
  if (
    byId.size !== snapshot.comments.length ||
    new Set(snapshot.receipts.map((entry) => entry.operationKey)).size !== snapshot.receipts.length
  ) {
    invalidSnapshot("duplicate");
  }
  const comments = new Map<string, unknown[]>();
  const visited = new Set<string>();
  for (const entry of snapshot.comments) {
    if (entities.get(entry.taskId)?.kind !== "task") {
      invalidSnapshot("comment.taskId");
    }
    const chain = new Set<string>();
    let cursor: typeof entry | undefined = entry;
    while (cursor !== undefined && !visited.has(cursor.comment.id)) {
      if (chain.has(cursor.comment.id)) {
        invalidSnapshot("comment.order.cycle");
      }
      chain.add(cursor.comment.id);
      if (cursor.after === null) {
        break;
      }
      const next = byId.get(cursor.after);
      if (next === undefined || next.taskId !== entry.taskId) {
        invalidSnapshot("comment.after");
      }
      cursor = next;
    }
    for (const id of chain) {
      visited.add(id);
    }
    const journal = comments.get(entry.taskId) ?? [];
    journal.push(entry.comment);
    comments.set(entry.taskId, journal);
  }
  return comments;
}

/**
 * Проверяет полное сохранённое состояние одним индексом и одним графом в памяти.
 * Это проверка состояния, не повторная попытка завершить все исторически done/released записи.
 */
export function validateSnapshot(snapshot: PortableProjectSnapshot): ReplicationIndex {
  validateComponentOwners(snapshot);
  const comments = validateAddressesAndComments(snapshot);
  const records = snapshotRecords(snapshot);
  const references = indexIntegrityRecords(records);
  if (
    references.counts.get("project") !== 1 ||
    references.byId.get(snapshot.projectId)?.kind !== "project" ||
    references.counts.get("product") !== 1 ||
    references.productBoards !== 1
  ) {
    invalidSnapshot("singletons");
  }
  for (const record of records) {
    const issues = inspectEntityReferences(record, references);
    if (issues.length > 0) {
      throw new RelayError("REPLICATION_INVARIANT", replicationMessages.invariant, 4, { issues });
    }
  }
  const decoded = records.map((record) => decodeStoredRecord(record, snapshot, comments));
  const tasks = decoded.filter((record) => record.kind === "task");
  const project = decoded.find(
    (record) => record.kind === "project" && record.id === snapshot.projectId,
  );
  if (project?.kind !== "project") {
    invalidSnapshot("singletons");
  }
  const sections = indexDocumentSections(project);
  const index: ReplicationIndex = {
    byId: new Map(decoded.map((record) => [record.id, record])),
    tasks,
    plans: decoded.filter((record) => record.kind === "work-plan"),
    sessions: decoded.filter((record) => record.kind === "work-session"),
    checkpoints: decoded.filter((record) => record.kind === "work-checkpoint"),
    graph: new TaskGraph(tasks.map(taskGraphNode)),
    sections,
  };
  for (const record of decoded) {
    if (record.kind === "document") {
      projectDocumentSection(record, sections);
    }
  }
  validateSnapshotRelations(index);
  return index;
}
