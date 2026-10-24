import { RelayError, type GitSyncControlOutcome } from "@relay/contracts";
import type { ControlOperations } from "../local/operations";
import type { NetworkExchange } from "../worker/network-exchange";
import type { ReplicationAdapter } from "../sync/replication-adapter";
import { appMessages } from "./app.messages";
import { conflictSummary } from "./conflicts";

/**
 * Принимает явное network действие и сохраняет его фактический terminal результат отдельно от HTTP ожидания.
 */
export function submitNetworkOperation(
  operations: ControlOperations,
  exchange: NetworkExchange,
  replication: ReplicationAdapter,
  requestId: string,
  action: "now" | "status",
  status: () => Promise<unknown>,
): GitSyncControlOutcome {
  return operations.submit(requestId, action, action, async (started) => {
    await exchange.run(action === "status", started);
    const result = await status();
    if (action === "now" && replication.status().conflicts > 0) {
      throw new RelayError("SYNC_CONFLICT", appMessages.conflicts, 4, {
        status: result,
        conflicts: replication.conflicts().map(conflictSummary),
      });
    }
    return result;
  });
}
