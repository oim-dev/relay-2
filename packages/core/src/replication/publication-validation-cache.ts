import type { PortableProjectSnapshot } from "@relay/contracts";
import { replicationSnapshotKey } from "./snapshot-decoder";

const VERIFIED_PUBLICATIONS_LIMIT = 128;
const verifiedPublications = new Map<string, true>();

/**
 * Адресует точные JSON-входы уже проверенного перехода, включая source/effects и полные proofs.
 * Неканонический порядок ключей может дать cache miss, но никогда не разрешает другой payload.
 * Проверка JSON предотвращает коллизию NaN/undefined/prototype с их lossy JSON.stringify формой.
 * Cache ограничен процессом/версией Core и размером; он не подменяет входную history chain.
 */
export function publicationValidationKey(
  parent: PortableProjectSnapshot,
  remote: PortableProjectSnapshot,
): string {
  return `${replicationSnapshotKey(parent)}:${replicationSnapshotKey(remote)}`;
}

/**
 * Переиспользует только успешное доказательство тех же immutable входов, обновляя ограниченный LRU.
 */
export function isVerifiedPublication(key: string): boolean {
  if (!verifiedPublications.has(key)) {
    return false;
  }
  verifiedPublications.delete(key);
  verifiedPublications.set(key, true);
  return true;
}

/**
 * Запоминает доказательство лишь после полного ordered replay и проверки точного результата.
 */
export function rememberVerifiedPublication(key: string): void {
  verifiedPublications.set(key, true);
  if (verifiedPublications.size > VERIFIED_PUBLICATIONS_LIMIT) {
    const oldest = verifiedPublications.keys().next().value;
    if (oldest !== undefined) {
      verifiedPublications.delete(oldest);
    }
  }
}
