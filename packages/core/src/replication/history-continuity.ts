import { RelayError, type PortableProjectSnapshot } from "@relay/contracts";
import { decodeHistoryCheckpoint, decodeHistorySession } from "../history/history-data";
import { replicationMessages } from "./replication.messages";
import { snapshotRecords } from "./snapshot-records";
import { assertHistoryContinuity } from "../history/history-run-transition";

/**
 * Проверяет монотонную историю принятого предка без переисполнения динамических task/release переходов.
 * Новые материалы не могут принадлежать уже завершённому в base run или закрытому intent.
 */
export function validateAcceptedHistory(
  base: PortableProjectSnapshot,
  remote: PortableProjectSnapshot,
): void {
  const previous = new Map(snapshotRecords(base).map((record) => [record.id, record]));
  const closedIntents = new Set(
    base.entities
      .filter(
        (entry) =>
          entry.record.kind === "work-checkpoint" &&
          ["result", "cancel"].includes(String(entry.record.data.kind)),
      )
      .map((entry) => entry.record.data.intentId),
  );
  for (const record of snapshotRecords(remote)) {
    const entry = { record };
    const before = previous.get(entry.record.id);
    if (before?.kind === "work-session" && entry.record.kind === "work-session") {
      try {
        assertHistoryContinuity(decodeHistorySession(before), decodeHistorySession(entry.record));
      } catch (error) {
        if (!(error instanceof RelayError) || error.code !== "CONFLICT") {
          throw error;
        }
        throw new RelayError(
          "REPLICATION_IMMUTABLE",
          replicationMessages.immutable,
          4,
          error.details,
        );
      }
    }
    if (before !== undefined) {
      continue;
    }
    if (entry.record.kind === "work-session") {
      const session = decodeHistorySession(entry.record);
      if (
        session.data.originCheckpointId !== null &&
        closedIntents.has(session.data.originCheckpointId)
      ) {
        throw new RelayError("REPLICATION_IMMUTABLE", replicationMessages.immutable, 4);
      }
    }
    if (entry.record.kind === "work-checkpoint") {
      const checkpoint = decodeHistoryCheckpoint(entry.record);
      const owner = previous.get(checkpoint.data.sessionId);
      if (owner?.kind === "work-session") {
        const run = decodeHistorySession(owner).data.runs.find(
          (item) => item.id === checkpoint.data.runId,
        );
        if (run !== undefined && run.state !== "active") {
          throw new RelayError("REPLICATION_OWNERSHIP", replicationMessages.immutable, 4);
        }
      }
      if (checkpoint.data.intentId !== null && closedIntents.has(checkpoint.data.intentId)) {
        throw new RelayError("REPLICATION_IMMUTABLE", replicationMessages.immutable, 4);
      }
    }
  }
}
