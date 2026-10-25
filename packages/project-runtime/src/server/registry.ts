import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { RelayError, validateActor, type ServerScope } from "@relay/contracts";
import { acquireLocalLock } from "@relay/storage";
import { hasCode } from "../configuration/files";
import type { RuntimeOptions } from "../configuration/runtime-options.types";
import { gitSyncHome } from "../git-sync/service";
import { serverMessages as messages } from "./server.messages";
import { resolveServerScope } from "./scope";
import type { ServerEndpoint, ServerLaunch, ServerLaunchInput } from "./server.types";

export const SERVER_REGISTRY_MAX_BYTES = 1024 * 1024;

/**
 * Проверяет UUID до использования идентификатора как имени каталога.
 */
export function isServerInstanceId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/u.test(value)
  );
}

/**
 * Сужает неизвестный JSON на границе файлов/control без утверждения конкретной схемы.
 */
export function serverObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Разрешает физический home; отсутствие допустимо для list без побочной записи.
 */
export function serverHome(options: RuntimeOptions): string {
  const home = gitSyncHome(options);
  try {
    return realpathSync(home);
  } catch (cause) {
    if (hasCode(cause, "ENOENT")) {
      return home;
    }
    throw cause;
  }
}

/**
 * Адресует только один проверенный UUID внутри реестра выбранного home.
 */
export function serverDirectory(home: string, instanceId: string): string {
  if (!isServerInstanceId(instanceId)) {
    throw new RelayError("INVALID_ARGUMENT", messages.invalidInput, 2);
  }
  return join(home, "servers", instanceId);
}

/**
 * Читает ограниченный локальный JSON; отсутствие отличается от повреждения и ошибок доступа.
 */
export function readServerJson(path: string): unknown {
  const stat = statSync(path);
  if (!stat.isFile() || stat.size > SERVER_REGISTRY_MAX_BYTES) {
    throw new RelayError("SERVER_REGISTRY_INVALID", messages.invalid, 4, { path });
  }
  const text = readFileSync(path, "utf8");
  try {
    return JSON.parse(text);
  } catch (cause) {
    const error = new RelayError("SERVER_REGISTRY_INVALID", messages.invalid, 4, { path });
    error.cause = cause;
    throw error;
  }
}

/**
 * Проверяет публичный URL приложения; произвольные host/credentials/редиректы не используются control-клиентом.
 */
export function isServerUrl(value: unknown): value is string {
  if (typeof value !== "string") {
    return false;
  }
  try {
    const url = new URL(value);
    return (
      url.protocol === "http:" &&
      url.hostname === "127.0.0.1" &&
      !url.username &&
      !url.password &&
      url.pathname === "/" &&
      !url.search &&
      !url.hash
    );
  } catch {
    return false;
  }
}

/**
 * Проверяет минимальную область, не читая проектную БД.
 */
export function isServerScope(value: unknown): value is ServerScope {
  return (
    serverObject(value) &&
    (value.kind === "project" || value.kind === "workspace") &&
    typeof value.configPath === "string" &&
    isAbsolute(value.configPath) &&
    (value.project === null || typeof value.project === "string")
  );
}

/**
 * Создаёт эксклюзивную регистрацию нового UUID после проверки области и автора.
 * Манифест не хранит окружение, секреты либо соединения; ошибка не затрагивает другие регистрации.
 */
export function createServerLaunch(
  options: RuntimeOptions,
  input: ServerLaunchInput,
): ServerLaunch {
  const port = input.port ?? 0;
  if (
    !Number.isInteger(port) ||
    port < 0 ||
    port > 65535 ||
    !input.version ||
    !["service", "foreground"].includes(input.mode)
  ) {
    throw new RelayError("INVALID_ARGUMENT", messages.invalidInput, 2);
  }
  const actor = input.actor ?? "web";
  validateActor(actor);
  const { scope } = resolveServerScope(options);
  mkdirSync(serverHome(options), { recursive: true, mode: 0o700 });
  const home = serverHome(options);
  const instanceId = randomUUID();
  const directory = serverDirectory(home, instanceId);
  mkdirSync(dirname(directory), { recursive: true, mode: 0o700 });
  mkdirSync(directory, { mode: 0o700 });
  const launch: ServerLaunch = {
    protocol: 1,
    instanceId,
    version: input.version,
    home,
    path: join(directory, "launch.json"),
    scope,
    options: {
      cwd: realpathSync(options.cwd),
      config: scope.configPath,
      home,
      ...(options.project !== undefined ? { project: options.project } : {}),
    },
    actor,
    port,
    mode: input.mode,
  };
  writeFileSync(launch.path, JSON.stringify(launch), { flag: "wx", mode: 0o600 });
  return launch;
}

/**
 * Декодирует launch и сверяет путь с физическим home/UUID, исключая перенос записи в чужой реестр.
 * Сохранённый cwd/config передаются приложению явно; их актуальное предметное состояние проверяет запуск.
 */
export function readServerLaunch(path: string): ServerLaunch {
  const value = readServerJson(path);
  if (
    !serverObject(value) ||
    value.protocol !== 1 ||
    !isServerInstanceId(value.instanceId) ||
    typeof value.version !== "string" ||
    !value.version ||
    typeof value.home !== "string" ||
    !isAbsolute(value.home) ||
    typeof value.path !== "string" ||
    !isServerScope(value.scope) ||
    !serverObject(value.options) ||
    typeof value.options.cwd !== "string" ||
    !isAbsolute(value.options.cwd) ||
    value.options.config !== value.scope.configPath ||
    value.options.home !== value.home ||
    (value.options.project ?? null) !== value.scope.project ||
    typeof value.actor !== "string" ||
    !Number.isInteger(value.port) ||
    typeof value.port !== "number" ||
    value.port < 0 ||
    value.port > 65535 ||
    (value.mode !== "foreground" && value.mode !== "service")
  ) {
    throw new RelayError("SERVER_REGISTRY_INVALID", messages.invalid, 4, { path });
  }
  const expectedPath = join(
    serverDirectory(realpathSync(value.home), value.instanceId),
    "launch.json",
  );
  if (
    resolve(path) !== expectedPath ||
    value.path !== expectedPath ||
    value.home !== realpathSync(value.home)
  ) {
    throw new RelayError("SERVER_REGISTRY_INVALID", messages.invalid, 4, { path });
  }
  validateActor(value.actor);
  return {
    protocol: 1,
    instanceId: value.instanceId,
    version: value.version,
    home: value.home,
    path: value.path,
    scope: value.scope,
    actor: value.actor,
    port: value.port,
    mode: value.mode,
    options: {
      cwd: value.options.cwd,
      config: value.scope.configPath,
      home: value.home,
      ...(value.scope.project !== null ? { project: value.scope.project } : {}),
    },
  };
}

/**
 * Читает приватный endpoint и проверяет границы его адреса; секрет не добавляется в ошибки.
 */
export function readServerEndpoint(launch: ServerLaunch): ServerEndpoint | null {
  const path = join(dirname(launch.path), "endpoint.json");
  let value: unknown;
  try {
    value = readServerJson(path);
  } catch (cause) {
    if (hasCode(cause, "ENOENT")) {
      return null;
    }
    throw cause;
  }
  if (
    !serverObject(value) ||
    value.protocol !== 1 ||
    value.instanceId !== launch.instanceId ||
    value.home !== launch.home ||
    !isServerInstanceId(value.bootId) ||
    typeof value.nonce !== "string" ||
    !/^[\da-f]{64}$/u.test(value.nonce) ||
    typeof value.controlPort !== "number" ||
    !Number.isInteger(value.controlPort) ||
    value.controlPort < 1 ||
    value.controlPort > 65535 ||
    typeof value.pid !== "number" ||
    !Number.isSafeInteger(value.pid) ||
    value.pid < 1 ||
    typeof value.version !== "string" ||
    !value.version ||
    !isServerUrl(value.url) ||
    typeof value.startedAt !== "string" ||
    !Number.isFinite(Date.parse(value.startedAt))
  ) {
    throw new RelayError("SERVER_REGISTRY_INVALID", messages.invalid, 4, { path });
  }
  return {
    protocol: 1,
    instanceId: launch.instanceId,
    home: launch.home,
    bootId: value.bootId,
    nonce: value.nonce,
    controlPort: value.controlPort,
    pid: value.pid,
    version: value.version,
    url: value.url,
    startedAt: value.startedAt,
  };
}

/**
 * Проверяет освобождение lifetime mutex реальным захватом; PID и отсутствие endpoint не заменяют барьер.
 */
export function probeServerLease(launch: ServerLaunch): "free" | "busy" {
  const path = join(dirname(launch.path), "ownership.sqlite");
  if (!existsSync(path)) {
    return "free";
  }
  try {
    const lock = acquireLocalLock(path);
    lock.release();
    return "free";
  } catch (cause) {
    if (cause instanceof RelayError && cause.code === "LOCAL_LOCK_BUSY") {
      return "busy";
    }
    throw cause;
  }
}
