import type { Database } from "bun:sqlite";
import type { PortableProjectSnapshot } from "@relay/contracts";
import { captureStoredProject } from "./replication-store";
import { commitReplicationImport } from "./replication-import-commit";
import { planReplicationImport } from "./replication-import-plan";
import type { ReplicationImportPlan } from "./replication.types";
import {
  invalidateCurrentPublication,
  writeReplicationConfirmations,
} from "./replication-metadata";

/**
 * Применяет проверенный Core снимок через единый sparse writer typed таблиц.
 * Готовый план не перечитывает полный проект; иначе дельта вычисляется в удерживаемой транзакции.
 * Вызывающий владеет outer transaction и guard поздних изменений; импорт не создаёт echo-outbox.
 * Удаление отвергнутых неопубликованных записей разрешает Core, immutable совпадения проверяет planner.
 * Фактическая переносимая дельта снимает прежний current proof; publication входного candidate
 * не назначается автоматически. Core отдельно привязывает доказанный proof после полного accept.
 * Любая переносимая дельта повышает transport revision, включая receipt-only без нового поколения.
 */
export function importStoredProject(
  connection: Database,
  snapshot: PortableProjectSnapshot,
  plan?: ReplicationImportPlan,
): void {
  const changes =
    plan ?? planReplicationImport(captureStoredProject(connection, snapshot.projectId), snapshot);
  const hasDelta =
    changes.entities.length +
      changes.componentUpserts.length +
      changes.componentRemovals.length +
      changes.commentsAdded.length +
      changes.commentsRemoved.length +
      changes.receiptsAdded.length >
    0;
  if (hasDelta) {
    invalidateCurrentPublication(connection);
  }
  commitReplicationImport(connection, changes);
  const confirmationsChanged = writeReplicationConfirmations(connection, snapshot.confirmations);
  if (hasDelta || confirmationsChanged) {
    connection.exec("UPDATE replication_state SET revision=revision+1 WHERE singleton=1");
  }
}
