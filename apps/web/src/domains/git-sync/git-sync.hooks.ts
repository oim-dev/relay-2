import { useEffect, useRef, useState } from "react";
import type { GitSyncControlOutcome, HttpGitSyncStatus } from "@relay/contracts";
import type { SWRResponse } from "swr";
import { useProject, useRead, errorMessage } from "domains/project";
import { relayClient, RelayApiError } from "infra/relay-api";
import type { GitSyncRequestState } from "./git-sync.types";

/**
 * Читает cached Runtime status; периодическое чтение не запускает Git fetch.
 */
export function useGitSync(): SWRResponse<HttpGitSyncStatus> {
  const status = useRead("gitSyncStatus", {});
  const { mutate } = status;
  useEffect(() => {
    const timer = window.setInterval(() => {
      void mutate();
    }, 15_000);
    return () => window.clearInterval(timer);
  }, [mutate]);
  return status;
}

/**
 * Явно запускает bounded now через Server/Runtime. После queued/running опрашивает
 * только существующий requestId; неизвестный исход не повторяет сетевую операцию.
 */
export function useRequestGitSync(): GitSyncRequestState {
  const { projectId } = useProject();
  const [pending, setPending] = useState(false);
  const [outcome, setOutcome] = useState<GitSyncControlOutcome>();
  const [error, setError] = useState<string>();
  const alive = useRef(true);
  const active = useRef(false);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    if (outcome?.state !== "queued" && outcome?.state !== "running") {
      return;
    }
    let disposed = false;
    const timer = window.setTimeout(() => {
      void relayClient
        .read(projectId, "gitSyncRequest", { requestId: outcome.requestId })
        .then((response) => {
          if (!disposed) {
            setOutcome(response.data);
          }
        })
        .catch((failure: unknown) => {
          if (!disposed) {
            setError(errorMessage(failure));
          }
        });
    }, 1_000);
    return () => {
      disposed = true;
      window.clearTimeout(timer);
    };
  }, [outcome, projectId]);
  /**
   * Читает достоверный сохранённый исход; ошибка чтения остаётся видимой без нового now.
   */
  async function readOutcome(requestId: string): Promise<void> {
    try {
      const response = await relayClient.read(projectId, "gitSyncRequest", { requestId });
      if (alive.current) {
        setOutcome(response.data);
        setError(undefined);
      }
    } catch (failure) {
      if (alive.current) {
        setError(errorMessage(failure));
      }
    }
  }

  /**
   * Повторно наблюдает уже известный requestId, сохраняя отсутствие исхода до ответа.
   */
  async function refresh(): Promise<void> {
    if (outcome !== undefined) {
      await readOutcome(outcome.requestId);
    }
  }

  /**
   * Запускает одно явное окно обмена. HTTP-ошибка с requestId приводит только к GET
   * сохранённого исхода: failed не выводится из сообщения и не повторяет Git-операцию.
   */
  async function request(): Promise<void> {
    if (active.current) {
      return;
    }
    active.current = true;
    setPending(true);
    setError(undefined);
    setOutcome(undefined);
    try {
      const response = await relayClient.gitSyncNow(projectId);
      if (alive.current) {
        setOutcome(response.data);
      }
    } catch (failure) {
      if (alive.current) {
        setError(errorMessage(failure));
      }
      const requestId = failure instanceof RelayApiError ? failure.details?.requestId : undefined;
      if (typeof requestId === "string" && requestId.length > 0) {
        await readOutcome(requestId);
      }
    } finally {
      active.current = false;
      if (alive.current) {
        setPending(false);
      }
    }
  }

  return {
    pending: pending || outcome?.state === "queued" || outcome?.state === "running",
    outcome,
    error,
    refresh,
    request,
  };
}
