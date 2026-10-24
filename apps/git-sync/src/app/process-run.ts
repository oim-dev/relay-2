import { join, resolve } from "node:path";
import { realpathSync } from "node:fs";
import { GIT_SYNC_REQUEST_MAX_BYTES, RelayError, type GitSyncResponse } from "@relay/contracts";
import type { WorkerOptions } from "../worker/context.types";
import { executeAction } from "./actions";
import { decodeRequest } from "./protocol";
import { failure } from "./errors";
import { appMessages } from "./app.messages";
import { homeDirectory, readConfiguration, stateDirectory } from "../local/state";
import { runWorker } from "../worker/worker";
import { runSupervisor } from "../worker/supervisor";

/**
 * Считывает stdin до EOF с ограничением памяти; лишний JSON не принимается как второй запрос.
 */
async function readRequest(): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    const bytes = Buffer.from(chunk);
    size += bytes.length;
    if (size > GIT_SYNC_REQUEST_MAX_BYTES) {
      throw new RelayError("GIT_SYNC_INVALID_REQUEST", appMessages.invalidRequest, 2);
    }
    chunks.push(bytes);
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
  } catch {
    throw new RelayError("GIT_SYNC_INVALID_REQUEST", appMessages.invalidRequest, 2);
  }
}

/**
 * Разбирает только приватные lifecycle-флаги; пользовательская справка принадлежит relay CLI.
 */
function foregroundOptions(args: readonly string[]): WorkerOptions {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (
      !key ||
      ![
        "--home",
        "--config",
        "--database",
        "--supervisor-instance",
        "--expected-project",
        "--expected-replica",
      ].includes(key) ||
      !value ||
      value.startsWith("--") ||
      values.has(key)
    ) {
      throw new RelayError("INVALID_ARGUMENT", appMessages.argument, 2);
    }
    values.set(key, value);
  }
  const cwd = process.cwd();
  const home = values.get("--home") ?? process.env.RELAY_HOME;
  const config = values.get("--config");
  const database = values.get("--database");
  const supervisorInstance = values.get("--supervisor-instance");
  const expectedProjectId = values.get("--expected-project");
  const expectedReplicaId = values.get("--expected-replica");
  if (database) {
    const saved = readConfiguration(stateDirectory(realpathSync(resolve(cwd, database))));
    if (!saved) {
      throw new RelayError("GIT_SYNC_NOT_CONNECTED", appMessages.notConnected, 4);
    }
    return {
      cwd,
      databasePath: realpathSync(resolve(cwd, database)),
      home: saved.home,
      ...(supervisorInstance === undefined ? {} : { supervisorInstance }),
      ...(expectedProjectId === undefined ? {} : { expectedProjectId }),
      ...(expectedReplicaId === undefined ? {} : { expectedReplicaId }),
    };
  }
  return {
    cwd,
    ...(home === undefined ? {} : { home }),
    ...(config === undefined ? {} : { config }),
    ...(supervisorInstance === undefined ? {} : { supervisorInstance }),
    ...(expectedProjectId === undefined ? {} : { expectedProjectId }),
    ...(expectedReplicaId === undefined ? {} : { expectedReplicaId }),
  };
}

/**
 * Запускает единственный JSON request либо долгоживущий foreground-компонент с graceful signals.
 * stdout request содержит ровно один JSON, exitCode совпадает с его структурированной ошибкой.
 */
export async function runProcessEntry(args: readonly string[]): Promise<number> {
  if (args.length === 1 && args[0] === "--request") {
    let response: GitSyncResponse;
    try {
      response = {
        version: 1,
        ok: true,
        data: await executeAction(decodeRequest(await readRequest())),
      };
    } catch (error) {
      response = failure(error);
    }
    process.stdout.write(JSON.stringify(response) + "\n");
    return response.ok ? 0 : response.error.exitCode;
  }
  if (args.length === 0 || args[0] === "--help") {
    process.stdout.write(appMessages.help + "\n");
    return 0;
  }
  if (args[0] !== "worker" && args[0] !== "supervise") {
    throw new RelayError("INVALID_ARGUMENT", appMessages.argument, 2);
  }
  const leaseFlags = args.filter((arg) => arg === "--parent-lease").length;
  if (leaseFlags > 1) {
    throw new RelayError("INVALID_ARGUMENT", appMessages.argument, 2);
  }
  const options = foregroundOptions(args.slice(1).filter((arg) => arg !== "--parent-lease"));
  if (
    args[0] === "supervise" &&
    (options.config !== undefined ||
      options.databasePath !== undefined ||
      options.supervisorInstance !== undefined)
  ) {
    throw new RelayError("INVALID_ARGUMENT", appMessages.argument, 2);
  }
  const shutdown = new AbortController();
  /**
   * Передаёт сигнал владельцу; Git children отменяются до закрытия соединения и readiness.
   */
  function stop(): void {
    shutdown.abort();
  }
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  if (leaseFlags === 1) {
    process.stdin.on("end", stop);
    process.stdin.on("error", stop);
    process.stdin.resume();
    if (process.stdin.readableEnded) {
      stop();
    }
  }
  try {
    if (args[0] === "supervise") {
      await runSupervisor(join(homeDirectory(options)), shutdown);
    } else {
      await runWorker(options, shutdown);
    }
    return 0;
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    if (leaseFlags === 1) {
      process.stdin.off("end", stop);
      process.stdin.off("error", stop);
      process.stdin.destroy();
    }
  }
}
