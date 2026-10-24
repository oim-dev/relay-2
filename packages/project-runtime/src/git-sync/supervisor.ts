import { readFileSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { setTimeout as pause } from "node:timers/promises";
import { RelayError } from "@relay/contracts";
import { hasCode } from "../configuration/files";
import { gitSyncMessages as messages } from "./git-sync.messages";
import type {
  GitSyncControlEndpoint,
  GitSyncSupervisorStatus,
  SupervisorProbeOptions,
} from "./supervisor.types";

const MAX_HEALTH_BYTES = 64 * 1024;
const READINESS_INTERVAL_MS = 50;

/**
 * Сопоставляет версию поставки с поколением локального control-протокола.
 */
export function gitSyncControlRelease(version: string): string {
  return `${version}/git-sync-v1`;
}

/**
 * Сужает внешний JSON без утверждения предметной формы ответа.
 */
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Декодирует readiness-файл; неизвестная/повреждённая форма не считается отсутствием процесса.
 */
export function readGitSyncControlEndpoint(path: string): GitSyncControlEndpoint | null {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if (hasCode(error, "ENOENT")) {
      return null;
    }
    throw error;
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new RelayError("GIT_SYNC_CONTROL_INVALID", messages.controlInvalid, 4);
  }
  if (
    Buffer.byteLength(text, "utf8") > MAX_HEALTH_BYTES ||
    !object(value) ||
    value.version !== 1 ||
    (value.kind !== "worker" && value.kind !== "supervisor") ||
    typeof value.port !== "number" ||
    !Number.isInteger(value.port) ||
    value.port < 1 ||
    value.port > 65535 ||
    typeof value.pid !== "number" ||
    !Number.isInteger(value.pid) ||
    value.pid < 1 ||
    typeof value.release !== "string" ||
    !value.release ||
    typeof value.identity !== "string" ||
    !value.identity ||
    typeof value.instance !== "string" ||
    !value.instance ||
    typeof value.capability !== "string" ||
    !value.capability ||
    typeof value.startedAt !== "string" ||
    !value.startedAt
  ) {
    throw new RelayError("GIT_SYNC_CONTROL_INVALID", messages.controlInvalid, 4);
  }
  return {
    version: 1,
    release: value.release,
    kind: value.kind,
    identity: value.identity,
    instance: value.instance,
    pid: value.pid,
    port: value.port,
    capability: value.capability,
    startedAt: value.startedAt,
  };
}

/**
 * Читает малый health-ответ с ограничением до накопления тела, закрывая поток при превышении.
 */
async function readHealthResponse(response: Response): Promise<unknown> {
  if (!response.body) {
    return null;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) {
        break;
      }
      size += chunk.value.byteLength;
      if (size > MAX_HEALTH_BYTES) {
        await reader.cancel();
        return null;
      }
      chunks.push(chunk.value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } finally {
    reader.releaseLock();
  }
}

/**
 * Запрашивает только health на loopback без редиректов; endpoint capability не входит в диагностику.
 */
async function health(
  endpoint: GitSyncControlEndpoint,
  options: SupervisorProbeOptions,
): Promise<unknown> {
  const timeout = AbortSignal.timeout(options.timeoutMs ?? 2000);
  try {
    const response = await fetch(`http://127.0.0.1:${endpoint.port}/control`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${endpoint.capability}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        version: 1,
        instance: endpoint.instance,
        action: "health",
        input: {},
      }),
      signal: options.signal ? AbortSignal.any([options.signal, timeout]) : timeout,
      redirect: "error",
    });
    if (!response.ok) {
      await response.body?.cancel();
      return null;
    }
    return await readHealthResponse(response);
  } catch {
    if (options.signal?.aborted) {
      throw new RelayError(
        "GIT_SYNC_CANCELLED",
        messages.processCancelled,
        options.signal.reason === "SIGTERM" ? 143 : 130,
      );
    }
    return null;
  }
}

/**
 * Проверяет отзывчивость supervisor по версии, instance, kind и физическому home.
 * Наличие readiness/PID-файла без соответствующего ответа никогда не означает running.
 */
export async function probeGitSyncSupervisor(
  home: string,
  options: SupervisorProbeOptions,
): Promise<GitSyncSupervisorStatus> {
  if (options.signal?.aborted) {
    throw new RelayError(
      "GIT_SYNC_CANCELLED",
      messages.processCancelled,
      options.signal.reason === "SIGTERM" ? 143 : 130,
    );
  }
  let identity = resolve(home);
  try {
    identity = realpathSync(identity);
  } catch (error) {
    if (!hasCode(error, "ENOENT")) {
      throw error;
    }
  }
  const endpoint = readGitSyncControlEndpoint(join(identity, "git-sync/supervisor.json"));
  const unknown = {
    instance: endpoint?.instance ?? null,
    release: endpoint?.release ?? null,
    pid: endpoint?.pid ?? null,
    heartbeat: null,
    responsive: false,
  };
  if (!endpoint) {
    return { ...unknown, actual: "stopped" };
  }
  const release = gitSyncControlRelease(options.version);
  if (
    endpoint.kind !== "supervisor" ||
    endpoint.identity !== identity ||
    endpoint.release !== release
  ) {
    return { ...unknown, actual: "incompatible" };
  }
  const response = await health(endpoint, options);
  if (
    !object(response) ||
    response.version !== 1 ||
    response.ok !== true ||
    !object(response.data)
  ) {
    return { ...unknown, actual: "unresponsive" };
  }
  const data = response.data;
  if (
    data.version !== 1 ||
    data.release !== release ||
    data.instance !== endpoint.instance ||
    data.identity !== identity ||
    data.kind !== "supervisor" ||
    typeof data.heartbeat !== "string"
  ) {
    return { ...unknown, actual: "incompatible" };
  }
  return { ...unknown, actual: "running", responsive: true, heartbeat: data.heartbeat };
}

/**
 * После native start ожидает подтверждённую готовность нового instance; повторяется только read-only health.
 * Deadline сохраняет установленную службу и возвращает GIT_SYNC_NOT_READY с последним статусом.
 */
export async function waitForGitSyncSupervisor(
  home: string,
  options: SupervisorProbeOptions,
): Promise<GitSyncSupervisorStatus> {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const status = await probeGitSyncSupervisor(home, {
      ...options,
      timeoutMs: Math.max(1, Math.min(2000, deadline - Date.now())),
    });
    const previous =
      options.previousInstance !== undefined && status.instance === options.previousInstance;
    if (status.responsive && !previous) {
      return status;
    }
    if ((status.actual === "incompatible" && !previous) || Date.now() >= deadline) {
      throw new RelayError("GIT_SYNC_NOT_READY", messages.supervisorNotReady, 4, {
        home,
        supervisor: status,
      });
    }
    try {
      await pause(Math.min(READINESS_INTERVAL_MS, Math.max(1, deadline - Date.now())), undefined, {
        signal: options.signal,
      });
    } catch {
      throw new RelayError(
        "GIT_SYNC_CANCELLED",
        messages.processCancelled,
        options.signal?.reason === "SIGTERM" ? 143 : 130,
      );
    }
  }
}
