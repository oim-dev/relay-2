import { mkdirSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import { GIT_SYNC_REQUEST_MAX_BYTES, RelayError } from "@relay/contracts";
import { acquireLocalLock, type LocalLock } from "@relay/storage";
import { combineProcessFailures } from "@relay/project-runtime";
import { decodeResponse, requestObject, requiredString } from "../app/protocol";
import { appMessages } from "../app/app.messages";
import { failure } from "../app/errors";
import { readLocalJson, writeLocalJson } from "./files";
import type { ControlEndpoint, ControlOwner, ControlRequest, ControlResult } from "./control.types";
import { version } from "../../package.json";
import { gitExecutionSignal, requireGitExecutionActive } from "../execution/context";

export const COMPONENT_RELEASE = `${version}/git-sync-v1`;

/**
 * Обозначает неподтверждённое освобождение listener/endpoint/mutex до внешней классификации отмены.
 * Исходные filesystem/stop ошибки сохраняются целиком в cause, без распознавания по errno или тексту.
 */
function controlCleanupFailure(cause: unknown, path: string): RelayError {
  const failure = new RelayError("GIT_CLEANUP_FAILED", appMessages.controlCleanup, 1, {
    operation: "control-owner-cleanup",
    path,
  });
  failure.cause = cause;
  return failure;
}

/**
 * Читает ответ IPC с ограничением во время чтения, а не после полной буферизации.
 */
async function responseJson(response: Response): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) {
    throw new RelayError("GIT_SYNC_INVALID_REQUEST", appMessages.invalidRequest, 2);
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) {
        break;
      }
      size += chunk.value.byteLength;
      if (size > 8 * 1024 * 1024) {
        await reader.cancel();
        throw new RelayError("GIT_SYNC_OUTPUT_LIMIT", appMessages.responseLimit, 1);
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
  } catch (cause) {
    const error = new RelayError("GIT_SYNC_PROTOCOL_ERROR", appMessages.invalidResponse, 1);
    error.cause = cause;
    throw error;
  }
}

/**
 * Читает endpoint, не считая наличие файла доказательством живости процесса.
 */
export function readEndpoint(path: string): ControlEndpoint | null {
  const value = readLocalJson(path);
  if (value === undefined) {
    return null;
  }
  const item = requestObject(value);
  if (
    item.version !== 1 ||
    (item.kind !== "worker" && item.kind !== "supervisor" && item.kind !== "request") ||
    typeof item.port !== "number" ||
    !Number.isInteger(item.port) ||
    item.port < 1 ||
    item.port > 65535 ||
    typeof item.pid !== "number" ||
    !Number.isInteger(item.pid) ||
    item.pid < 1
  ) {
    throw new RelayError("GIT_SYNC_STATE_INVALID", appMessages.state, 4);
  }
  return {
    version: 1,
    release: requiredString(item.release),
    kind: item.kind,
    identity: requiredString(item.identity),
    instance: requiredString(item.instance),
    pid: item.pid,
    port: item.port,
    capability: requiredString(item.capability),
    startedAt: requiredString(item.startedAt),
    ...(item.supervisorInstance === undefined
      ? {}
      : { supervisorInstance: requiredString(item.supervisorInstance) }),
  };
}

/**
 * Отправляет один ограниченный запрос только на loopback и проверяет JSON-ответ.
 * Запрос с неясным сетевым исходом автоматически не повторяется.
 * Транспортный отказ или локальный HTTP timeout дают null — отзывчивость owner не подтверждена.
 * Отмена обращения прерывает также чтение ответа и передаётся ошибкой, а не превращается в null.
 */
export async function controlRequest(
  endpoint: ControlEndpoint,
  action: string,
  input: Record<string, unknown> = {},
  timeoutMs = 2000,
  requestId: string = crypto.randomUUID(),
): Promise<ControlResult> {
  requireGitExecutionActive();
  const signal = gitExecutionSignal(AbortSignal.timeout(timeoutMs));
  try {
    const response = await fetch(`http://127.0.0.1:${endpoint.port}/control`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${endpoint.capability}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ version: 1, requestId, instance: endpoint.instance, action, input }),
      ...(signal === undefined ? {} : { signal }),
      redirect: "error",
    });
    const value = await responseJson(response);
    requireGitExecutionActive();
    return decodeResponse(value);
  } catch (error) {
    requireGitExecutionActive(error);
    if (error instanceof RelayError) {
      throw error;
    }
    return null;
  }
}

/**
 * Подтверждает готовность challenge-response с версией, instance и физической идентичностью.
 */
export async function responsive(
  endpoint: ControlEndpoint,
  options: { readonly compatibleRelease?: boolean } = {},
): Promise<boolean> {
  const response = await controlRequest(endpoint, "health");
  if (!response?.ok) {
    return false;
  }
  const health = requestObject(response.data);
  return (
    health.version === 1 &&
    health.release ===
      (options.compatibleRelease === false ? endpoint.release : COMPONENT_RELEASE) &&
    health.instance === endpoint.instance &&
    health.identity === endpoint.identity &&
    health.kind === endpoint.kind &&
    health.supervisorInstance === endpoint.supervisorInstance
  );
}

/**
 * Захватывает единый Storage mutex для owner и коротких обновлений расписания, без endpoint/bind.
 * Вызывающий освобождает lock в finally; занятость даёт GIT_SYNC_WORKER_BUSY, crash освобождает lock в ОС.
 */
export function acquireControlLock(path: string): LocalLock {
  requireGitExecutionActive();
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  try {
    return acquireLocalLock(`${path}.ownership.sqlite`);
  } catch (cause) {
    if (cause instanceof RelayError && cause.code === "LOCAL_LOCK_BUSY") {
      const error = new RelayError("GIT_SYNC_WORKER_BUSY", appMessages.busy, 4);
      error.cause = cause;
      throw error;
    }
    throw cause;
  }
}

/**
 * Удерживает общий с локальными обновлениями расписания mutex и публикует endpoint после подготовки/bind.
 * Crash освобождает lock в ОС; наличие endpoint само по себе не доказывает владение.
 * Отказ публикации дожидается закрытия listener до освобождения mutex; cleanup сохраняет исходную ошибку.
 */
export async function ownControl(
  path: string,
  kind: ControlEndpoint["kind"],
  identity: string,
  handler: (request: ControlRequest, signal: AbortSignal) => Promise<unknown>,
  beforeReady?: () => Promise<void>,
  supervisorInstance?: string,
): Promise<ControlOwner> {
  const lock = acquireControlLock(path);
  try {
    await beforeReady?.();
    requireGitExecutionActive();
    const instance = crypto.randomUUID();
    const capability = crypto.randomUUID() + crypto.randomUUID();
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      maxRequestBodySize: GIT_SYNC_REQUEST_MAX_BYTES,
      /**
       * Проверяет capability и instance до вызова действия; здоровье не требует доступа к Git.
       */
      async fetch(request, server): Promise<Response> {
        try {
          if (
            request.method !== "POST" ||
            new URL(request.url).pathname !== "/control" ||
            request.headers.get("authorization") !== `Bearer ${capability}`
          ) {
            throw new RelayError("GIT_SYNC_UNAUTHORIZED", appMessages.auth, 4);
          }
          const value = requestObject(await request.json());
          if (value.version !== 1 || value.instance !== instance) {
            throw new RelayError("GIT_SYNC_PROTOCOL_VERSION", appMessages.incompatible, 4);
          }
          const action = requiredString(value.action);
          if (action === "network.lease") {
            // Только authenticated streaming lease имеет lifetime вместо обычного HTTP idle timeout.
            server.timeout(request, 0);
          }
          const data =
            action === "health"
              ? {
                  version: 1,
                  release: COMPONENT_RELEASE,
                  kind,
                  identity,
                  instance,
                  startedAt: endpoint.startedAt,
                  heartbeat: new Date().toISOString(),
                  ...(supervisorInstance === undefined ? {} : { supervisorInstance }),
                }
              : await handler(
                  {
                    version: 1,
                    requestId:
                      value.requestId === undefined
                        ? crypto.randomUUID()
                        : requiredString(value.requestId),
                    instance,
                    action,
                    input: requestObject(value.input),
                  },
                  request.signal,
                );
          if (data instanceof Response) {
            return data;
          }
          return Response.json({ version: 1, ok: true, data });
        } catch (error) {
          return Response.json(failure(error));
        }
      },
    });
    const endpoint: ControlEndpoint = {
      version: 1,
      release: COMPONENT_RELEASE,
      kind,
      identity,
      instance,
      pid: process.pid,
      port: server.port ?? 0,
      capability,
      startedAt: new Date().toISOString(),
      ...(supervisorInstance === undefined ? {} : { supervisorInstance }),
    };
    try {
      writeLocalJson(path, endpoint);
    } catch (error) {
      try {
        await server.stop(true);
      } catch (cleanupError) {
        throw combineProcessFailures(error, controlCleanupFailure(cleanupError, path));
      }
      throw error;
    }
    return {
      endpoint,
      /**
       * Снимает readiness до освобождения lifetime mutex; повторное закрытие безопасно.
       * Все этапы cleanup выполняются и ожидаются даже при отказе; несколько ошибок сохраняются вместе.
       */
      async close(): Promise<void> {
        const failures: unknown[] = [];
        try {
          if (readEndpoint(path)?.instance === instance) {
            unlinkSync(path);
          }
        } catch (error) {
          failures.push(error);
        }
        try {
          await server.stop(true);
        } catch (error) {
          failures.push(error);
        }
        try {
          lock.release();
        } catch (error) {
          failures.push(error);
        }
        if (failures.length > 0) {
          throw controlCleanupFailure(failures.reduce(combineProcessFailures), path);
        }
      },
    };
  } catch (error) {
    try {
      lock.release();
    } catch (cleanupError) {
      throw combineProcessFailures(error, controlCleanupFailure(cleanupError, path));
    }
    throw error;
  }
}
