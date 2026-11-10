import type { ProjectDatabase } from "@relay/core";
import type { ReplicationAdapter } from "../../../src/sync/replication-adapter";
import type { ExchangeDatabaseState } from "./crash-exchange.types";

/**
 * Снимает согласованное наблюдение реальной БД без повторения пользовательских команд.
 */
export function observeExchangeDatabase(
  db: ProjectDatabase,
  replication: ReplicationAdapter,
): ExchangeDatabaseState {
  return db.snapshot(() => {
    const snapshot = replication.capture();
    const ids = snapshot.entities.map((entry) => entry.record.id).sort();
    return {
      snapshot,
      base: replication.acceptedSnapshot(),
      outbox: db.getReplicationOutbox(),
      generation: db.getGeneration(),
      revisions: ids.map((id) => {
        const record = db.get(id);
        if (!record) {
          throw new Error(`В снимке отсутствует локальный владелец ${id}`);
        }
        return [id, record.revision] as const;
      }),
    };
  });
}
