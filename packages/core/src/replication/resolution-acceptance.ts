import type { PortableProjectSnapshot, ReplicationResolution } from "@relay/contracts";

/**
 * Возвращает привязанное к принятому source решение; null обозначает принятие без ручной поправки.
 * Caller предварительно проверяет наличие exact confirmation и его proof.
 */
export function confirmedResolution(snapshot: PortableProjectSnapshot, id: string): string | null {
  const separator = id.lastIndexOf(":");
  const proof = snapshot.confirmations
    .find((entry) => entry.replicaId === id.slice(0, separator))
    ?.proofs?.find((entry) => entry.sequence === Number(id.slice(separator + 1)));
  return proof?.resolutionId ?? null;
}

/**
 * Узнаёт явное локальное принятие уже опубликованного решения вместо поздней непереданной поправки.
 * Это отмена локального предложения; immutable canonical proof повторно не переписывается.
 */
export function isResolutionAdoption(
  resolution: ReplicationResolution,
  accepted: string | null,
): boolean {
  return (
    resolution.choice === "remote" &&
    resolution.material.code === "REPLICATION_RESOLUTION_STALE" &&
    Object.hasOwn(resolution.material, "acceptedResolutionId") &&
    resolution.material.acceptedResolutionId === accepted
  );
}
