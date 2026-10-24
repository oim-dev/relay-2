import type { ReplicationConfirmation } from "@relay/contracts";
import { canonicalJson } from "@relay/storage";

/**
 * Проверяет точную причинную отметку без сравнения локальных часов или ревизий.
 */
export function isConfirmed(
  confirmations: readonly ReplicationConfirmation[],
  id: string,
): boolean {
  const separator = id.lastIndexOf(":");
  const replica = id.slice(0, separator);
  const sequence = Number(id.slice(separator + 1));
  if (
    separator < 1 ||
    !Number.isSafeInteger(sequence) ||
    sequence < 1 ||
    String(sequence) !== id.slice(separator + 1)
  ) {
    return false;
  }
  return (
    confirmations
      .find((entry) => entry.replicaId === replica)
      ?.ranges.some(([first, last]) => sequence >= first && sequence <= last) ?? false
  );
}

/**
 * Добавляет точечное подтверждение, компактно объединяя соседние принятые интервалы.
 */
export function confirmChangeset(
  confirmations: readonly ReplicationConfirmation[],
  replicaId: string,
  sequence: number,
  digest: string,
): ReplicationConfirmation[] {
  const previous = confirmations.find((entry) => entry.replicaId === replicaId)?.ranges ?? [];
  const intervals = [
    ...previous.map(([first, last]): [number, number] => [first, last]),
    [sequence, sequence] as [number, number],
  ].sort((a, b) => a[0] - b[0]);
  const ranges: [number, number][] = [];
  for (const [first, last] of intervals) {
    const tail = ranges.at(-1);
    if (tail !== undefined && first <= tail[1] + 1) {
      tail[1] = Math.max(last, tail[1]);
    } else {
      ranges.push([first, last]);
    }
  }
  const existing = confirmations.find((entry) => entry.replicaId === replicaId)?.proofs ?? [];
  const proofs = [
    ...existing.filter((entry) => entry.sequence !== sequence),
    { sequence, digest },
  ].sort((a, b) => a.sequence - b.sequence);
  return [
    ...confirmations.filter((entry) => entry.replicaId !== replicaId),
    { replicaId, ranges, proofs },
  ].sort((a, b) => (a.replicaId < b.replicaId ? -1 : 1));
}

/**
 * Проверяет монотонность принятого remote по полным интервалам, не разворачивая их в ID.
 */
export function retainsConfirmations(
  previous: readonly ReplicationConfirmation[],
  next: readonly ReplicationConfirmation[],
): boolean {
  return previous.every((entry) => {
    const target = next.find((item) => item.replicaId === entry.replicaId);
    const ranges = target?.ranges ?? [];
    const proofs = new Map(
      target?.proofs?.map((proof) => [proof.sequence, canonicalJson(proof)]) ?? [],
    );
    return (
      entry.ranges.every(([first, last]) => ranges.some(([a, b]) => a <= first && b >= last)) &&
      (entry.proofs ?? []).every((proof) => proofs.get(proof.sequence) === canonicalJson(proof))
    );
  });
}
