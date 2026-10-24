import type { ReplicationConflict } from "@relay/contracts";
import type { ReplicationDependencyWait } from "@relay/core";

/**
 * Согласованный диагностический снимок локальных конфликтов и полного графа ожиданий.
 */
export interface ReplicationDiagnostics {
  /* Все сохранённые трёхсторонние конфликты. */
  readonly conflicts: readonly ReplicationConflict[];
  /* Все pending source с ещё не принятыми dependencies. */
  readonly blocked: readonly ReplicationDependencyWait[];
}
