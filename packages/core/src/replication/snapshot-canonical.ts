import { componentIdentity, type PortableProjectSnapshot } from "@relay/contracts";

/**
 * Канонизирует только наборы первичных записей; порядок текста и предметных коллекций не меняется.
 */
export function canonicalSnapshot(snapshot: PortableProjectSnapshot): PortableProjectSnapshot {
  return {
    ...snapshot,
    entities: [...snapshot.entities].sort((a, b) => (a.record.id < b.record.id ? -1 : 1)),
    ...(snapshot.components === undefined
      ? {}
      : {
          components: [...snapshot.components].sort((a, b) =>
            componentIdentity(a) < componentIdentity(b) ? -1 : 1,
          ),
        }),
    addresses: [...snapshot.addresses].sort((a, b) => (a.ref < b.ref ? -1 : 1)),
    comments: [...snapshot.comments].sort((a, b) => (a.comment.id < b.comment.id ? -1 : 1)),
    receipts: [...snapshot.receipts].sort((a, b) => (a.operationKey < b.operationKey ? -1 : 1)),
    confirmations: [...snapshot.confirmations].sort((a, b) => (a.replicaId < b.replicaId ? -1 : 1)),
  };
}
