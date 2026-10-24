import { join } from "node:path";
import { RelayError } from "@relay/contracts";
import { appMessages } from "../app/app.messages";
import { requestObject } from "../app/protocol";
import { readEndpoint, responsive } from "../local/control";
import type { ControlEndpoint } from "../local/control.types";

/**
 * Удерживает host permit живым stream. EOF/падение S отменяет Git через отдельный attempt signal.
 * One-shot без S допустим; после получения lease запрещён fallback к unbudgeted выполнению.
 */
export async function withNetworkPermit(
  home: string,
  worker: ControlEndpoint,
  signal: AbortSignal,
  operation: (signal: AbortSignal) => Promise<void>,
): Promise<void> {
  const supervisor = readEndpoint(join(home, "git-sync", "supervisor.json"));
  if (!supervisor) {
    if (worker.kind === "worker" && worker.supervisorInstance) {
      throw new RelayError("GIT_SYNC_LEASE_LOST", appMessages.leaseLost, 4);
    }
    return operation(signal);
  }
  if (!(await responsive(supervisor)) && worker.kind === "request") {
    return operation(signal);
  }
  const connection = new AbortController();
  const lost = new AbortController();
  const granted = Promise.withResolvers<void>();
  const requestId = crypto.randomUUID();
  let accepted = false;
  let finished = false;
  let monitor: Promise<void> | undefined;
  try {
    const response = await fetch(`http://127.0.0.1:${supervisor.port}/control`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${supervisor.capability}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        version: 1,
        requestId,
        instance: supervisor.instance,
        action: "network.lease",
        input: { databasePath: worker.identity, instance: worker.instance },
      }),
      signal: AbortSignal.any([signal, connection.signal]),
      redirect: "error",
    });
    if (!response.body || !response.headers.get("content-type")?.includes("application/x-ndjson")) {
      throw new RelayError("SUPERVISOR_NOT_RUNNING", appMessages.supervisorNotRunning, 4);
    }
    const reader = response.body.getReader();
    monitor = (async () => {
      let buffered = "";
      const decoder = new TextDecoder("utf-8", { fatal: true });
      try {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) {
            break;
          }
          buffered += decoder.decode(chunk.value, { stream: true });
          if (buffered.length > 16_384) {
            throw new Error("lease frame limit");
          }
          let newline: number;
          while ((newline = buffered.indexOf("\n")) >= 0) {
            const event = requestObject(JSON.parse(buffered.slice(0, newline)));
            buffered = buffered.slice(newline + 1);
            if (
              event.version !== 1 ||
              event.requestId !== requestId ||
              typeof event.leaseId !== "string" ||
              (event.state !== "queued" && event.state !== "granted")
            ) {
              throw new Error("lease protocol");
            }
            if (event.state === "granted") {
              accepted = true;
              granted.resolve();
            }
          }
        }
      } catch (error) {
        if (!finished) {
          granted.reject(error);
        }
      } finally {
        if (!finished) {
          lost.abort();
          if (!accepted) {
            granted.reject(new RelayError("GIT_SYNC_LEASE_LOST", appMessages.leaseLost, 4));
          }
        }
        reader.releaseLock();
      }
    })();
    await granted.promise;
    await operation(AbortSignal.any([signal, lost.signal]));
    if (lost.signal.aborted) {
      throw new RelayError("GIT_SYNC_LEASE_LOST", appMessages.leaseLost, 4);
    }
  } catch (error) {
    if (lost.signal.aborted && !signal.aborted) {
      throw new RelayError("GIT_SYNC_LEASE_LOST", appMessages.leaseLost, 4);
    }
    throw error;
  } finally {
    finished = true;
    connection.abort();
    await monitor;
  }
}
