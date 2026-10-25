import { useEffect, useEffectEvent, useRef } from "react";
import useSWR, { type SWRResponse } from "swr";
import type {
  GitSyncConflictList,
  GitSyncControlOutcome,
  HttpGitSyncStatus,
} from "@relay/contracts";
import { useProject } from "domains/project";
import { relayClient } from "infra/relay-api";
import { gitSyncDeliverySignal } from "./helpers/delivery-signal";

/**
 * Перечитывает реальную conflicts/blocked проекцию при открытии панели, изменении
 * значимых полей cached status и завершении ручного now. Одинаковый status-снимок
 * не запускает повторное чтение графа; закрытая панель его не опрашивает.
 */
export function useGitSyncConflicts(
  opened: boolean,
  status: SWRResponse<HttpGitSyncStatus>,
  outcome: GitSyncControlOutcome | undefined,
): SWRResponse<GitSyncConflictList> {
  const scope = useProject();
  const enabled = opened && status.data?.connected === true;
  const signal = gitSyncDeliverySignal(status.data);
  const requested = useRef<string | null | undefined>(undefined);
  const conflicts = useSWR<GitSyncConflictList>(
    enabled ? [scope.serverKey, scope.projectId, "gitSyncConflicts", {}] : null,
    async () => (await relayClient.read(scope.projectId, "gitSyncConflicts", {})).data,
    {
      revalidateOnMount: false,
      revalidateIfStale: false,
      revalidateOnFocus: false,
      revalidateOnReconnect: false,
    },
  );
  const { mutate } = conflicts;
  useEffect(() => {
    if (!enabled) {
      requested.current = undefined;
      return;
    }
    if (requested.current !== signal) {
      requested.current = signal;
      void mutate();
    }
  }, [enabled, signal, mutate]);

  /**
   * Сначала обновляет status. Изменённый сигнал уже обслуживает эффект выше;
   * неизменённый или неизвестный status требует отдельного чтения по terminal outcome.
   */
  const refreshAfterOutcome = useEffectEvent(async (): Promise<void> => {
    const before = gitSyncDeliverySignal(status.data);
    const current = await status.mutate();
    if (current === undefined || gitSyncDeliverySignal(current) === before) {
      await conflicts.mutate();
    }
  });
  const terminal = outcome?.state === "completed" || outcome?.state === "failed";
  const terminalKey = terminal ? `${outcome.requestId}:${outcome.state}` : null;
  useEffect(() => {
    if (terminalKey !== null) {
      void refreshAfterOutcome();
    }
  }, [terminalKey]);
  return conflicts;
}
