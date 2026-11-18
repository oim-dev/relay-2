import type { StoredReplicationDecision } from "@relay/storage";
import type { PendingReplicationPreparation } from "./replication-selection.types";

/**
 * Проверенное новое решение либо точный повтор с полным предпросмотром overlay.
 */
export interface PreparedKeyResolution {
  /* Новая immutable-запись; null при точном повторе без побочных эффектов. */
  readonly decision: StoredReplicationDecision | null;
  /* Решения всего pending overlay, включая проверяемое. */
  readonly decisions: readonly StoredReplicationDecision[];
  /* Полная проверка, предшествующая ограниченному preview. */
  readonly validated: PendingReplicationPreparation;
}
