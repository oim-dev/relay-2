import {
  RelayError,
  componentIdentity,
  type PortableProjectSnapshot,
  type PortableComment,
} from "@relay/contracts";
import { canonicalJson } from "./portable-version";
import type { ReplicationImportPlan } from "./replication.types";
import { storageReplicationMessages } from "./replication.messages";

/**
 * Вычисляет точный sparse patch в памяти до write transaction; входные снимки не изменяются.
 * Существующие immutable ID с иным payload отклоняются ещё до взятия замка записи.
 */
export function planReplicationImport(
  current: PortableProjectSnapshot,
  next: PortableProjectSnapshot,
): ReplicationImportPlan {
  const oldParts = new Map(
    (current.components ?? []).map((entry) => [componentIdentity(entry), entry]),
  );
  const newParts = new Map(
    (next.components ?? []).map((entry) => [componentIdentity(entry), entry]),
  );
  const componentUpserts = [...newParts]
    .filter(([key, part]) => oldParts.get(key)?.version !== part.version)
    .map(([, part]) => part);
  const componentRemovals = [...oldParts]
    .filter(([key]) => !newParts.has(key))
    .map(([, part]) => part);
  const touched = new Set(
    [...componentUpserts, ...componentRemovals].map((entry) => entry.ownerId),
  );
  const oldEntities = new Map(current.entities.map((entry) => [entry.record.id, entry]));
  const newEntities = new Map(next.entities.map((entry) => [entry.record.id, entry]));
  const entities = [...new Set([...oldEntities.keys(), ...newEntities.keys()])].flatMap((id) => {
    const before = oldEntities.get(id) ?? null;
    const after = newEntities.get(id) ?? null;
    return before?.version === after?.version && !touched.has(id) ? [] : [{ id, before, after }];
  });
  const oldComments = new Map(current.comments.map((entry) => [entry.comment.id, entry]));
  const newComments = new Map(next.comments.map((entry) => [entry.comment.id, entry]));
  const oldReceipts = new Map(current.receipts.map((entry) => [entry.operationKey, entry]));
  for (const entry of next.comments) {
    const before = oldComments.get(entry.comment.id);
    if (before !== undefined && canonicalJson(before) !== canonicalJson(entry)) {
      throw new RelayError(
        "REPLICATION_IMMUTABLE",
        storageReplicationMessages.immutableComment,
        4,
        { id: entry.comment.id },
      );
    }
  }
  for (const entry of next.receipts) {
    const before = oldReceipts.get(entry.operationKey);
    if (before !== undefined && canonicalJson(before) !== canonicalJson(entry)) {
      throw new RelayError(
        "REPLICATION_IMMUTABLE",
        storageReplicationMessages.immutableReceipt,
        4,
        { operationKey: entry.operationKey },
      );
    }
  }
  const commentsAdded = next.comments.filter((entry) => !oldComments.has(entry.comment.id));
  const commentsRemoved = current.comments.filter((entry) => !newComments.has(entry.comment.id));
  const journals = new Set([...commentsAdded, ...commentsRemoved].map((entry) => entry.taskId));
  const addresses = new Map(next.addresses.map((entry) => [entry.ref, entry.entityId]));
  return {
    projectId: next.projectId,
    entities,
    componentUpserts,
    componentRemovals,
    commentsAdded,
    commentsRemoved,
    commentOrder: [...journals].map((taskId) => ({
      taskId,
      ids: orderedCommentIds(next.comments.filter((entry) => entry.taskId === taskId)),
    })),
    receiptsAdded: next.receipts.filter((entry) => !oldReceipts.has(entry.operationKey)),
    remapped: current.addresses.flatMap((entry) => {
      const owner = addresses.get(entry.ref);
      return owner === undefined || owner === entry.entityId
        ? []
        : [{ ref: entry.ref, previousId: entry.entityId, currentId: owner }];
    }),
  };
}

/**
 * Разворачивает уже проверенный causal journal в общий порядок без сравнения авторских часов.
 */
function orderedCommentIds(comments: readonly PortableComment[]): string[] {
  const children = new Map<string | null, string[]>();
  for (const entry of comments) {
    const siblings = children.get(entry.after) ?? [];
    siblings.push(entry.comment.id);
    children.set(entry.after, siblings);
  }
  for (const siblings of children.values()) {
    siblings.sort();
  }
  const stack = [...(children.get(null) ?? [])].reverse();
  const ids: string[] = [];
  while (stack.length > 0) {
    const id = stack.pop();
    if (id === undefined) {
      continue;
    }
    ids.push(id);
    stack.push(...[...(children.get(id) ?? [])].reverse());
  }
  if (ids.length !== comments.length) {
    throw new RelayError("REPLICATION_FORMAT", storageReplicationMessages.immutableComment, 2);
  }
  return ids;
}
