import { readdirSync } from "node:fs";
import { join } from "node:path";
import {
  RelayError,
  type ServerInstanceList,
  type ServerInstanceStatus,
  type ServerProjectStatus,
} from "@relay/contracts";
import { hasCode } from "../configuration/files";
import type { RuntimeOptions } from "../configuration/runtime-options.types";
import {
  isServerInstanceId,
  isServerScope,
  probeServerLease,
  readServerEndpoint,
  readServerLaunch,
  serverDirectory,
  serverHome,
  serverObject,
  SERVER_REGISTRY_MAX_BYTES,
} from "./registry";
import { serverMessages as messages } from "./server.messages";
import type { ServerEndpoint, ServerEnvironment, ServerLaunch } from "./server.types";

/**
 * Не позволяет отменённой операции маскироваться под stale/отсутствующий health.
 */
export function checkServerCancellation(environment: ServerEnvironment): void {
  if (environment.signal?.aborted) {
    throw new RelayError(
      "SERVER_CANCELLED",
      messages.cancelled,
      environment.signal.reason === "SIGTERM" ? 143 : 130,
    );
  }
}

/**
 * Читает ограниченный UTF-8 JSON control, не накапливая неограниченный ответ неверного endpoint.
 */
async function controlJson(response: Response): Promise<unknown> {
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    return null;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) {
        return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
      }
      size += chunk.value.byteLength;
      if (size > SERVER_REGISTRY_MAX_BYTES) {
        await reader.cancel();
        return null;
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
}

/**
 * Обращается к известному boot только по loopback, с nonce и запретом redirect; не использует PID для сигналов.
 */
export async function serverControl(
  endpoint: ServerEndpoint,
  action: "health" | "stop",
  environment: ServerEnvironment,
): Promise<unknown> {
  checkServerCancellation(environment);
  const timeout = AbortSignal.timeout(Math.max(1, Math.min(environment.timeoutMs ?? 2000, 2000)));
  try {
    const response = await fetch(
      `http://127.0.0.1:${endpoint.controlPort}/control/${endpoint.instanceId}/${endpoint.bootId}/${action}`,
      {
        method: action === "health" ? "GET" : "POST",
        headers: { authorization: `Bearer ${endpoint.nonce}` },
        redirect: "error",
        signal: environment.signal ? AbortSignal.any([timeout, environment.signal]) : timeout,
      },
    );
    return await controlJson(response);
  } catch {
    checkServerCancellation(environment);
    return null;
  }
}

/**
 * Проверяет проекты health, не объявляя неизвестный JSON доверенным предметным DTO.
 */
function isProject(value: unknown): value is ServerProjectStatus {
  return (
    serverObject(value) &&
    (value.id === null || typeof value.id === "string") &&
    typeof value.name === "string" &&
    (value.slug === null || typeof value.slug === "string") &&
    typeof value.path === "string" &&
    typeof value.available === "boolean" &&
    (value.error === undefined ||
      (serverObject(value.error) &&
        typeof value.error.code === "string" &&
        typeof value.error.message === "string"))
  );
}

/**
 * Сверяет весь процессный identity с защищённым ответом; endpoint-файл сам по себе ready не означает.
 */
export async function probeServerInstance(
  launch: ServerLaunch,
  environment: ServerEnvironment,
): Promise<ServerInstanceStatus> {
  checkServerCancellation(environment);
  const endpoint = readServerEndpoint(launch);
  const lease = probeServerLease(launch);
  let state: ServerInstanceStatus["state"] = "stopped";
  if (lease === "busy") {
    state = "unresponsive";
  } else if (endpoint) {
    state = "stale";
  }
  const observed: ServerInstanceStatus = {
    instanceId: launch.instanceId,
    bootId: endpoint?.bootId ?? null,
    state,
    pid: endpoint?.pid ?? null,
    url: endpoint?.url ?? null,
    version: endpoint?.version ?? launch.version,
    mode: launch.mode,
    scope: launch.scope,
    projects: [],
    startedAt: endpoint?.startedAt ?? null,
  };
  if (!endpoint || lease === "free") {
    return observed;
  }
  if (endpoint.version !== environment.version || launch.version !== environment.version) {
    return { ...observed, state: "incompatible" };
  }
  const reply = await serverControl(endpoint, "health", environment);
  if (reply === null) {
    return observed;
  }
  if (
    !serverObject(reply) ||
    reply.protocol !== 1 ||
    reply.home !== launch.home ||
    !serverObject(reply.data)
  ) {
    return { ...observed, state: "incompatible" };
  }
  const data = reply.data;
  if (
    data.instanceId !== launch.instanceId ||
    data.bootId !== endpoint.bootId ||
    data.pid !== endpoint.pid ||
    data.version !== environment.version ||
    data.url !== endpoint.url ||
    data.state !== "ready" ||
    data.mode !== launch.mode ||
    data.startedAt !== endpoint.startedAt ||
    !isServerScope(data.scope) ||
    data.scope.kind !== launch.scope.kind ||
    data.scope.configPath !== launch.scope.configPath ||
    data.scope.project !== launch.scope.project ||
    !Array.isArray(data.projects) ||
    !data.projects.every(isProject)
  ) {
    return { ...observed, state: "incompatible" };
  }
  return { ...observed, state: "ready", projects: data.projects };
}

/**
 * Читает независимые регистрации одного home. Ошибка элемента сохраняется; секреты не попадают в DTO.
 * Выполняет не более одного bounded health за раз, стоимость линейна числу зарегистрированных экземпляров.
 */
export async function listServerInstances(
  options: RuntimeOptions,
  environment: ServerEnvironment,
  instanceId?: string,
): Promise<ServerInstanceList> {
  checkServerCancellation(environment);
  const home = serverHome(options);
  let ids: string[];
  if (instanceId !== undefined) {
    serverDirectory(home, instanceId);
    ids = [instanceId];
  } else {
    try {
      ids = readdirSync(join(home, "servers")).filter(isServerInstanceId).sort();
    } catch (cause) {
      if (!hasCode(cause, "ENOENT")) {
        throw cause;
      }
      ids = [];
    }
  }
  const items: ServerInstanceStatus[] = [];
  for (const id of ids) {
    try {
      items.push(
        await probeServerInstance(
          readServerLaunch(join(serverDirectory(home, id), "launch.json")),
          environment,
        ),
      );
    } catch (cause) {
      checkServerCancellation(environment);
      if (instanceId !== undefined && hasCode(cause, "ENOENT")) {
        throw new RelayError("SERVER_NOT_FOUND", messages.notFound, 3, { instanceId });
      }
      items.push({
        instanceId: id,
        bootId: null,
        state: "invalid",
        pid: null,
        url: null,
        version: null,
        mode: null,
        scope: null,
        projects: [],
        startedAt: null,
        error: {
          code: cause instanceof RelayError ? cause.code : "SERVER_REGISTRY_INVALID",
          message: cause instanceof Error ? cause.message : messages.invalid,
        },
      });
    }
  }
  return {
    version: 1,
    home,
    running: items.filter((item) => item.state === "ready").length,
    registered: items.length,
    items,
  };
}
