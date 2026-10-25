import { RelayError } from "@relay/contracts";
import {
  acquireServerInstance,
  combineProcessFailures,
  createGitSyncClient,
  createNativeProcessRunner,
  createServerLaunch,
  readServerLaunch,
  type ServerLaunch,
} from "@relay/project-runtime";
import { startRelayServer } from "../server";
import type { StartedRelayServer } from "../server.types";
import { createWebHandler } from "../modules/assets/static-handler";
import { ProjectsService } from "../modules/projects/projects.service";
import type { ServerControl, ServerEnvironment, ServerInvocation } from "./process.types";
import { processMessages as messages } from "./process.messages";
import { shutdown } from "./shutdown";

/**
 * Выбирает либо создаёт launch, проверяя выпуск и parent-lease до приобретения владения.
 */
function launchFor(invocation: ServerInvocation, version: string): ServerLaunch {
  if (invocation.kind === "direct") {
    return createServerLaunch(invocation.runtime, {
      ...invocation.input,
      version,
      mode: "foreground",
    });
  }
  if (invocation.kind !== "launch") {
    throw new RelayError("INVALID_ARGUMENT", messages.arguments, 2);
  }
  const launch = readServerLaunch(invocation.path);
  if (launch.version !== version) {
    throw new RelayError("SERVER_VERSION_MISMATCH", messages.version, 4, {
      expected: version,
      actual: launch.version,
      instanceId: launch.instanceId,
    });
  }
  if (invocation.parentLease && launch.mode !== "foreground") {
    throw new RelayError("INVALID_ARGUMENT", messages.lease, 2);
  }
  return launch;
}

/**
 * Ожидает сигнал, не теряя abort, полученный до подписки.
 */
function stopped(signal: AbortSignal): Promise<void> {
  return signal.aborted
    ? Promise.resolve()
    : new Promise((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
}

/**
 * Композирует реальный Nest HTTP, embedded Web, Runtime регистрацию и guarded Git Sync.
 * Заканчивается только после освобождения lease; при fatal shutdown main обязан выйти из процесса.
 */
export async function bootstrapServer(
  invocation: ServerInvocation,
  environment: ServerEnvironment,
  control: ServerControl,
  version: string,
): Promise<void> {
  if (control.signal.aborted) {
    return;
  }
  const launch = launchFor(invocation, version);
  const registration = acquireServerInstance(launch);
  const requests = new AbortController();
  let server: StartedRelayServer | undefined;
  let failure: unknown;
  let failed = false;
  try {
    const gitSync = createGitSyncClient({
      cwd: launch.options.cwd,
      env: environment.env,
      executablePath: environment.executablePath,
      userHome: environment.userHome,
      version,
      signal: requests.signal,
      ...(environment.env.RELAY_GIT_SYNC_BIN === undefined
        ? {}
        : { binary: environment.env.RELAY_GIT_SYNC_BIN }),
      ...(environment.standalone
        ? { runner: createNativeProcessRunner([environment.executablePath]) }
        : {}),
    });
    server = await startRelayServer({
      runtime: launch.options,
      version,
      actor: launch.actor,
      port: launch.port,
      hostname: "127.0.0.1",
      gitSync,
      staticHandler: createWebHandler(),
      allowedOrigins: "allowedOrigins" in invocation ? invocation.allowedOrigins : [],
    });
    if (!control.signal.aborted) {
      registration.ready({
        url: server.url,
        projects: server.app.get(ProjectsService).status,
        onStop: control.stop,
      });
      await control.stdout(
        `${JSON.stringify({ event: "ready", instanceId: launch.instanceId, bootId: registration.bootId, pid: process.pid, url: server.url, version })}\n`,
      );
    }
    await stopped(control.signal);
  } catch (error) {
    failed = true;
    failure = error;
  }
  try {
    if (server === undefined) {
      registration.close();
    } else {
      await shutdown(server, registration, requests);
    }
  } catch (cleanup) {
    throw failed ? combineProcessFailures(failure, cleanup) : cleanup;
  }
  if (failed) {
    throw failure;
  }
}
