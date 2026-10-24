import { join } from "node:path";
import { realpathSync } from "node:fs";
import { RelayError } from "@relay/contracts";
import type { RuntimeOptions } from "@relay/project-runtime";
import { controlRequest, readEndpoint, responsive } from "../local/control";
import { homeDirectory } from "../local/state";
import { workerStatus } from "../worker/status";
import { waitUntil } from "../local/deadline";
import { appMessages } from "./app.messages";
import { responseData } from "./errors";
import type { SyncConfiguration } from "../local/state.types";
import { COMPONENT_RELEASE } from "../local/control";
import type { ControlEndpoint } from "../local/control.types";
import type { ProjectStartOptions } from "../worker/project-control.types";

/**
 * Проверяет существующий S до изменения mode/desired; никаких native installation/spawn fallback.
 */
export async function readySupervisor(home: string): Promise<ControlEndpoint> {
  const endpoint = readEndpoint(join(home, "git-sync", "supervisor.json"));
  if (!endpoint) {
    throw new RelayError("SUPERVISOR_REQUIRED", appMessages.supervisorRequired, 4, {
      home,
      commands: ["relay git-sync service enable", "relay git-sync supervise"],
    });
  }
  if (
    endpoint.kind !== "supervisor" ||
    endpoint.identity !== realpathSync(home) ||
    endpoint.release !== COMPONENT_RELEASE
  ) {
    throw new RelayError("GIT_SYNC_PROTOCOL_VERSION", appMessages.incompatible, 4);
  }
  if (!(await responsive(endpoint))) {
    throw new RelayError("SUPERVISOR_NOT_RUNNING", appMessages.supervisorNotRunning, 4, { home });
  }
  return endpoint;
}

/**
 * Делегирует persistent start/restart живому S и ждёт подтверждённый результат. RPC не повторяется после потери ответа.
 */
export async function startSupervisedWorker(
  config: SyncConfiguration,
  options: ProjectStartOptions,
): Promise<void> {
  const supervisor = await readySupervisor(config.home);
  const requestId = crypto.randomUUID();
  const result = await controlRequest(
    supervisor,
    "project.start",
    { databasePath: config.databasePath, ...options },
    25_000,
    requestId,
  );
  if (result === null) {
    throw new RelayError("GIT_SYNC_OUTCOME_UNKNOWN", appMessages.outcomeUnknown, 4, {
      outcome: "unknown",
      home: config.home,
      requestId,
      instance: supervisor.instance,
      action: "project.start",
      query: ["relay", "git-sync", "status"],
    });
  }
  responseData(result);
}

/**
 * При доступном S ждёт также cleanup его job; отсутствие S не мешает прямому graceful stop worker.
 */
export async function stopSupervisedWorker(config: SyncConfiguration): Promise<boolean> {
  let supervisor: ControlEndpoint;
  try {
    supervisor = await readySupervisor(config.home);
  } catch (error) {
    if (
      error instanceof RelayError &&
      ["SUPERVISOR_REQUIRED", "SUPERVISOR_NOT_RUNNING", "GIT_SYNC_PROTOCOL_VERSION"].includes(
        error.code,
      )
    ) {
      return false;
    }
    throw error;
  }
  const requestId = crypto.randomUUID();
  const result = await controlRequest(
    supervisor,
    "project.stop",
    { databasePath: config.databasePath },
    25_000,
    requestId,
  );
  if (result === null) {
    throw new RelayError("GIT_SYNC_OUTCOME_UNKNOWN", appMessages.outcomeUnknown, 4, {
      outcome: "unknown",
      requestId,
      instance: supervisor.instance,
      action: "project.stop",
      query: ["relay", "git-sync", "status"],
    });
  }
  responseData(result);
  return true;
}

/**
 * Служебный API Runtime для graceful остановки supervisor перед native service disable/restart.
 * Не открывает проект; desired проектов сохраняется, чтобы следующий запуск службы возобновил их.
 */
export async function supervisorControl(
  action: "supervisor.status" | "supervisor.stop",
  options: RuntimeOptions,
): Promise<unknown> {
  const path = join(homeDirectory(options), "git-sync", "supervisor.json");
  const endpoint = readEndpoint(path);
  if (
    endpoint &&
    (endpoint.kind !== "supervisor" || endpoint.identity !== realpathSync(homeDirectory(options)))
  ) {
    throw new RelayError("GIT_SYNC_PROTOCOL_VERSION", appMessages.incompatible, 4);
  }
  if (action === "supervisor.status") {
    return workerStatus(path, endpoint ? "running" : "stopped");
  }
  if (!endpoint) {
    return { stopped: true };
  }
  if (!(await responsive(endpoint))) {
    throw new RelayError("GIT_SYNC_SUPERVISOR_UNAVAILABLE", appMessages.notReady, 4);
  }
  const response = await controlRequest(endpoint, "shutdown");
  if (response === null) {
    throw new RelayError("GIT_SYNC_SUPERVISOR_UNAVAILABLE", appMessages.notReady, 4);
  }
  responseData(response);
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const current = readEndpoint(path);
    if (!current || current.instance !== endpoint.instance) {
      return { stopped: true, instance: endpoint.instance };
    }
    await waitUntil(Date.now() + 50, AbortSignal.timeout(1000));
  }
  throw new RelayError("GIT_SYNC_WORKER_BUSY", appMessages.busy, 4);
}
