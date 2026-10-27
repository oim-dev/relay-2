import { RelayError } from "@relay/contracts";
import { bindUserServiceFiles } from "../native/user-service/files";
import type {
  UserServiceAdapter,
  UserServiceContext,
  UserServiceFailure,
} from "../native/user-service/service.types";
import type { GitSyncEnvironment } from "./client.types";
import { gitSyncMessages as messages } from "./git-sync.messages";
import { runNativeProcess } from "./process";
import type { ProcessResult } from "./process.types";
import { probeGitSyncSupervisorLock } from "./supervisor";

const failures = {
  command: { code: "GIT_SYNC_SERVICE_FAILED", message: messages.nativeFailed },
  ownership: { code: "GIT_SYNC_SERVICE_OWNERSHIP", message: messages.serviceOwnership },
  identity: { code: "GIT_SYNC_SERVICE_IDENTITY", message: messages.serviceIdentity },
  protocol: { code: "GIT_SYNC_SERVICE_PROTOCOL", message: messages.invalidResponse },
  lock: { code: "GIT_SYNC_SERVICE_FAILED", message: messages.supervisorLockBusy },
  cancelled: { code: "GIT_SYNC_CANCELLED", message: messages.processCancelled },
} as const satisfies Record<UserServiceFailure, Pick<RelayError, "code" | "message">>;

/**
 * Связывает механизм user-service с guardian, диагностикой и lifetime mutex supervisor.
 * Native не получает GitSyncEnvironment, не читает health и не знает расположения SQLite lock.
 */
export function createGitSyncServiceContext(
  environment: GitSyncEnvironment,
  adapter: UserServiceAdapter,
  home: string,
): UserServiceContext {
  return {
    files: bindUserServiceFiles(adapter, environment.serviceFiles),
    timeoutMs: environment.timeoutMs ?? 30_000,
    ...(environment.signal ? { signal: environment.signal } : {}),
    ...(environment.userId !== undefined ? { userId: environment.userId } : {}),
    /**
     * Передаёт текущий остаток stop budget тому же runner, сохраняя cwd/env/signal.
     */
    run: (command): Promise<ProcessResult> =>
      (environment.runner ?? runNativeProcess)({
        ...command,
        cwd: environment.cwd,
        env: environment.env,
        ...(environment.signal ? { signal: environment.signal } : {}),
      }),
    /**
     * Выполняет только технический захват/release mutex данного home; busy не превращается в free.
     */
    probeLease: (): "free" | "busy" =>
      (environment.supervisorLockProbe ?? probeGitSyncSupervisorLock)(home),
    /**
     * Код и сообщение остаются у Git Sync; native details и исходная причина не теряются.
     */
    failure(kind, exitCode, details, cause): RelayError {
      const descriptor = failures[kind];
      const error = new RelayError(descriptor.code, descriptor.message, exitCode, details);
      if (cause !== undefined) {
        error.cause = cause;
      }
      return error;
    },
  };
}
