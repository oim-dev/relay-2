import type {
  PortableProjectSnapshot,
  PublicationParent,
  ReplicationPublication,
} from "@relay/contracts";
import { replicationFingerprint } from "@relay/storage";
import { canonicalSnapshot } from "./snapshot-canonical";

/**
 * Связывает первичные данные, точные ack и результат без циклической ссылки publicationId→digest.
 * Исключаются только publication и publicationId внутри compact proofs; остальные proof-поля защищены.
 */
export function snapshotDigest(snapshot: PortableProjectSnapshot): string {
  const { publication: _publication, ...state } = canonicalSnapshot(snapshot);
  return replicationFingerprint({
    ...state,
    confirmations: state.confirmations.map((entry) => ({
      ...entry,
      proofs: entry.proofs?.map(({ publicationId: _id, ...proof }) => proof),
    })),
  });
}

/**
 * Возвращает непосредственную привязку к canonical parent; пустая ветка не имеет предка.
 */
export function publicationParent(snapshot: PortableProjectSnapshot): PublicationParent | null {
  return snapshot.entities.length === 0
    ? null
    : {
        publicationId: snapshot.publication?.publicationId ?? null,
        snapshotDigest: snapshotDigest(snapshot),
      };
}

/**
 * Хеширует полное проверочное содержимое публикации, исключая лишь её собственный ID.
 */
export function publicationIdentity(
  publication: Omit<ReplicationPublication, "publicationId">,
): string {
  return replicationFingerprint(publication);
}
