import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { RelayError, type ServerInstanceStatus } from "@relay/contracts";
import { acquireLocalLock } from "@relay/storage";
import { replaceLocalFile } from "../local-files/replace";
import { isServerUrl, readServerEndpoint, readServerLaunch } from "./registry";
import { serverMessages as messages } from "./server.messages";
import type {
  ServerEndpoint,
  ServerLaunch,
  ServerReadyInput,
  ServerRegistration,
} from "./server.types";

/**
 * Сравнивает секрет без утечки позиции несовпадения; произвольная длина отвергается до native compare.
 */
function authorized(request: Request, endpoint: ServerEndpoint): boolean {
  const token = request.headers.get("authorization") ?? "";
  const expected = `Bearer ${endpoint.nonce}`;
  return (
    !request.headers.has("origin") &&
    request.headers.get("host") === `127.0.0.1:${endpoint.controlPort}` &&
    token.length === expected.length &&
    Buffer.byteLength(token) === Buffer.byteLength(expected) &&
    timingSafeEqual(Buffer.from(token), Buffer.from(expected))
  );
}

/**
 * Формирует публичное наблюдение только готового приложения, исключая nonce и controlPort.
 */
function readyStatus(
  launch: ServerLaunch,
  endpoint: ServerEndpoint,
  input: ServerReadyInput,
): ServerInstanceStatus {
  const projects = typeof input.projects === "function" ? input.projects() : input.projects;
  return {
    instanceId: launch.instanceId,
    bootId: endpoint.bootId,
    state: "ready",
    pid: endpoint.pid,
    url: endpoint.url,
    version: endpoint.version,
    mode: launch.mode,
    scope: launch.scope,
    projects: projects.map((project) => ({
      id: project.id,
      name: project.name,
      slug: project.slug,
      path: project.path,
      available: project.available,
      ...(project.error
        ? { error: { code: project.error.code, message: project.error.message } }
        : {}),
    })),
    startedAt: endpoint.startedAt,
  };
}

/**
 * Получает exclusive lifetime mutex до HTTP bind. Crash освобождает mutex средствами ОС.
 * ready создаёт отдельный защищённый loopback endpoint; close принадлежит finally приложения,
 * вызывается после закрытия его HTTP/БД и удаляет только endpoint своего bootId.
 */
export function acquireServerInstance(source: ServerLaunch): ServerRegistration {
  const directory = dirname(readServerLaunch(source.path).path);
  const lock = acquireLocalLock(join(directory, "ownership.sqlite"));
  let launch: ServerLaunch;
  try {
    launch = readServerLaunch(source.path);
    if (
      launch.version !== source.version ||
      launch.mode !== source.mode ||
      launch.instanceId !== source.instanceId ||
      launch.home !== source.home ||
      launch.port !== source.port ||
      launch.actor !== source.actor ||
      launch.options.cwd !== source.options.cwd ||
      launch.options.config !== source.options.config ||
      launch.options.project !== source.options.project ||
      launch.scope.kind !== source.scope.kind
    ) {
      throw new RelayError("SERVER_LAUNCH_CHANGED", messages.launchChanged, 4);
    }
  } catch (cause) {
    lock.release();
    throw cause;
  }
  const bootId = randomUUID();
  let control: ReturnType<typeof Bun.serve> | undefined;
  let closed = false;
  let published = false;
  let stopping = false;
  return {
    bootId,
    /**
     * Публикует готовность только после bind приложения; повторный ready отклоняется.
     */
    ready(input): void {
      if (closed || control) {
        throw new RelayError("SERVER_REGISTRATION_INVALID", messages.closed, 4);
      }
      if (!isServerUrl(input.url)) {
        throw new RelayError("INVALID_ARGUMENT", messages.invalidUrl, 2);
      }
      let endpoint: ServerEndpoint = {
        protocol: 1,
        instanceId: launch.instanceId,
        bootId,
        nonce: randomBytes(32).toString("hex"),
        controlPort: 0,
        pid: process.pid,
        version: launch.version,
        home: launch.home,
        url: input.url,
        startedAt: new Date().toISOString(),
      };
      control = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        maxRequestBodySize: 1024,
        /**
         * Принимает только capability-authenticated health/stop конкретного boot без браузерного Origin.
         */
        fetch(request): Response {
          if (!authorized(request, endpoint)) {
            return new Response(null, { status: 403 });
          }
          const path = new URL(request.url).pathname;
          const prefix = `/control/${launch.instanceId}/${bootId}`;
          if (path === `${prefix}/health` && request.method === "GET" && !stopping) {
            return Response.json({
              protocol: 1,
              home: launch.home,
              data: readyStatus(launch, endpoint, input),
            });
          }
          if (path === `${prefix}/stop` && request.method === "POST") {
            if (!stopping) {
              stopping = true;
              // Возврат ответа предшествует teardown приложения и control listener.
              setTimeout(input.onStop, 0);
            }
            return Response.json({
              protocol: 1,
              instanceId: launch.instanceId,
              bootId,
              stopping: true,
            });
          }
          return new Response(null, { status: 404 });
        },
      });
      // Порт становится известен только после bind; fetch не вызывается до возврата в event loop.
      const controlPort = control.port;
      if (typeof controlPort !== "number") {
        control.stop(true);
        control = undefined;
        throw new RelayError("SERVER_REGISTRATION_INVALID", messages.invalid, 4);
      }
      endpoint = { ...endpoint, controlPort };
      const temporary = join(directory, `${bootId}.tmp`);
      try {
        writeFileSync(temporary, JSON.stringify(endpoint), { flag: "wx", mode: 0o600 });
        replaceLocalFile(temporary, join(directory, "endpoint.json"));
        published = true;
      } catch (cause) {
        control.stop(true);
        control = undefined;
        throw cause;
      } finally {
        rmSync(temporary, { force: true });
      }
    },
    /**
     * Снимает readiness при сигналах/EOF, сохраняя владение до завершения backend операций.
     */
    draining(): void {
      stopping = true;
    },
    /**
     * Освобождает только собственную публикацию и lease; при повреждении файла сохраняет его для диагностики.
     */
    close(): void {
      if (closed) {
        return;
      }
      closed = true;
      control?.stop(true);
      try {
        if (published && readServerEndpoint(launch)?.bootId === bootId) {
          rmSync(join(directory, "endpoint.json"));
        }
      } finally {
        lock.release();
      }
    },
  };
}
