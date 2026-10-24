import { realpathSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { RelayError } from "@relay/contracts";
import { failure } from "../app/errors";
import { appMessages } from "../app/app.messages";
import { requiredString } from "../app/protocol";
import { ownControl, readEndpoint, responsive } from "../local/control";
import { writeLocalJson } from "../local/files";
import { registeredProjects, stateDirectory } from "../local/state";
import { WorkerLauncher } from "./launch";
import { waitUntil } from "../local/deadline";
import { ProjectController } from "./project-control";
import { NetworkLeases } from "./network-leases";
import { recordSupervisorFailure } from "./supervisor-failure";

/**
 * Обслуживает явные конфиги одного home; независимые ошибки проектов не прерывают обход.
 * Не более четырёх запусков/проверок и четырёх сетевых циклов проектов одновременно.
 * После канонизации home сохраняет bounded fatal-record и пробрасывает исходную ошибку;
 * диагностическая запись не служит readiness и не меняет владение процессами.
 */
export async function runSupervisor(home: string, shutdown: AbortController): Promise<void> {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  home = realpathSync(home);
  try {
    await superviseHome(home, shutdown);
  } catch (error) {
    recordSupervisorFailure(home, error);
    throw error;
  }
}

/**
 * Удерживает control owner и workers уже проверенного home до shutdown; исходный fatal error
 * передаётся внешней границе записи диагностики без изменения кода, cause и cleanup-семантики.
 */
async function superviseHome(home: string, shutdown: AbortController): Promise<void> {
  const directory = join(home, "git-sync");
  const permits = new NetworkLeases();
  const retries = new Map<string, { failures: number; next: number }>();
  const outcomes = new Map<string, unknown>();
  let controller: ProjectController | undefined;
  const owner = await ownControl(
    join(directory, "supervisor.json"),
    "supervisor",
    home,
    async (request, signal) => {
      if (request.action === "shutdown") {
        setTimeout(() => shutdown.abort(), 0);
        return { stopping: true };
      }
      if (request.action === "status") {
        return {
          projects: registeredProjects(home),
          activeNetwork: permits.size,
          waitingNetwork: permits.queued,
          maximumNetwork: 4,
        };
      }
      if (request.action === "project.start" || request.action === "project.stop") {
        if (!controller) {
          throw new RelayError("GIT_SYNC_NOT_READY", appMessages.notReady, 4);
        }
        const databasePath = requiredString(request.input.databasePath);
        if (request.action === "project.stop") {
          await controller.stop(databasePath);
          return { stopped: true, databasePath };
        }
        if (
          (request.input.restart !== undefined && typeof request.input.restart !== "boolean") ||
          (request.input.mode !== undefined && request.input.mode !== "auto")
        ) {
          throw new RelayError("INVALID_ARGUMENT", appMessages.argument, 2);
        }
        const endpoint = await controller.start(
          databasePath,
          {
            ...(request.input.restart === true ? { restart: true } : {}),
            ...(request.input.mode === "auto" ? { mode: "auto" as const } : {}),
          },
          signal,
        );
        return {
          databasePath,
          instance: endpoint.instance,
          supervisorInstance: endpoint.supervisorInstance,
          ready: true,
          release: endpoint.release,
        };
      }
      if (request.action === "network.lease") {
        const instance = requiredString(request.input.instance);
        const databasePath = requiredString(request.input.databasePath);
        const endpoint = readEndpoint(join(stateDirectory(databasePath), "worker.json"));
        if (!endpoint || endpoint.instance !== instance || !(await responsive(endpoint))) {
          throw new RelayError("GIT_SYNC_NOT_READY", appMessages.notReady, 4);
        }
        return permits.open(request.requestId, signal);
      }
      throw new RelayError("GIT_SYNC_UNKNOWN_ACTION", appMessages.action, 2);
    },
  );
  const launcher = new WorkerLauncher(owner.endpoint.instance, shutdown.signal);
  const activeController = new ProjectController(home, launcher, shutdown.signal);
  controller = activeController;
  try {
    while (!shutdown.signal.aborted) {
      const projects = registeredProjects(home);
      for (let start = 0; start < projects.length; start += 4) {
        await Promise.all(
          projects.slice(start, start + 4).map(async (project) => {
            const previous = retries.get(project.databasePath);
            if (previous && previous.next > Date.now()) {
              return;
            }
            try {
              const endpoint = await activeController.reconcile(project.databasePath);
              if (endpoint) {
                outcomes.set(project.databasePath, {
                  databasePath: project.databasePath,
                  instance: endpoint.instance,
                  actual: "running",
                });
              } else {
                outcomes.set(project.databasePath, {
                  databasePath: project.databasePath,
                  actual: "stopped",
                });
              }
              retries.delete(project.databasePath);
            } catch (error) {
              const failures = (previous?.failures ?? 0) + 1;
              const next =
                Date.now() +
                Math.min(60_000, 500 * 2 ** Math.min(failures, 7)) * (0.5 + Math.random());
              retries.set(project.databasePath, { failures, next });
              outcomes.set(project.databasePath, {
                databasePath: project.databasePath,
                actual: "error",
                nextRetry: new Date(next).toISOString(),
                error: failure(error).error,
              });
            }
          }),
        );
      }
      writeLocalJson(join(directory, "supervisor-status.json"), {
        version: 1,
        instance: owner.endpoint.instance,
        heartbeat: new Date().toISOString(),
        projects: [...outcomes.entries()]
          .filter(([path]) => projects.some((project) => project.databasePath === path))
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([, result]) => result),
      });
      await waitUntil(Date.now() + 1000, shutdown.signal).catch((error) => {
        if (!shutdown.signal.aborted) {
          throw error;
        }
      });
    }
  } finally {
    shutdown.abort();
    permits.close();
    // Desired сохраняется, поэтому следующий login/crash restart возобновит работу.
    try {
      await activeController.close();
    } finally {
      await owner.close();
    }
  }
}
