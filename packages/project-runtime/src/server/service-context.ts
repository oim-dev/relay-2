import { RelayError } from "@relay/contracts";
import { runNativeProcess } from "../git-sync/process";
import type { ProcessResult } from "../git-sync/process.types";
import { bindUserServiceFiles } from "../native/user-service/files";
import type {
  UserServiceAdapter,
  UserServiceContext,
  UserServiceFailure,
} from "../native/user-service/service.types";
import { checkServerCancellation } from "./probe";
import { probeServerLease } from "./registry";
import { serverMessages as messages } from "./server.messages";
import type { ServerEnvironment, ServerLaunch } from "./server.types";

const failures = {
  command: { code: "SERVER_SERVICE_FAILED", message: messages.managerFailed },
  ownership: { code: "SERVER_SERVICE_OWNERSHIP", message: messages.ownership },
  identity: { code: "SERVER_SERVICE_IDENTITY", message: messages.invalidInput },
  protocol: { code: "SERVER_SERVICE_PROTOCOL", message: messages.managerFailed },
  lock: { code: "SERVER_SERVICE_FAILED", message: messages.managerFailed },
  cancelled: { code: "SERVER_CANCELLED", message: messages.managerFailed },
} as const satisfies Record<UserServiceFailure, Pick<RelayError, "code" | "message">>;

/**
 * Адаптирует существующие диагностики guarded runner к Server с сохранением причины.
 * Ошибки native-manager уже создаются через Server-порт, без промежуточных Git Sync ошибок.
 */
function serverServiceFailure(cause: unknown): never {
  if (!(cause instanceof RelayError) || !cause.code.startsWith("GIT_SYNC_")) {
    throw cause;
  }
  const code = cause.code.replace("GIT_SYNC_", "SERVER_");
  const message = code === "SERVER_SERVICE_OWNERSHIP" ? messages.ownership : messages.managerFailed;
  const error = new RelayError(code, message, cause.exitCode, cause.details);
  error.cause = cause;
  throw error;
}

/**
 * Подключает native-механизм к guardian и lifetime mutex именно выбранного Server UUID.
 * Lease/readiness и launch принадлежат Server; в native не передаются пути его реестра или GitSyncEnvironment.
 */
export function createServerServiceContext(
  environment: ServerEnvironment,
  adapter: UserServiceAdapter,
  launch: ServerLaunch,
): UserServiceContext {
  return {
    files: bindUserServiceFiles(adapter, environment.serviceFiles),
    timeoutMs: environment.timeoutMs ?? 30_000,
    ...(environment.signal ? { signal: environment.signal } : {}),
    ...(environment.userId !== undefined ? { userId: environment.userId } : {}),
    /**
     * Запускает manager с остатком общего stop budget, не отдавая ему дочерний Server в CLI lease.
     */
    async run(command): Promise<ProcessResult> {
      checkServerCancellation(environment);
      return (environment.runner ?? runNativeProcess)({
        ...command,
        cwd: environment.cwd,
        env: environment.env,
        ...(environment.signal ? { signal: environment.signal } : {}),
      }).catch(serverServiceFailure);
    },
    /**
     * Проверяет только ownership.sqlite данного UUID, а не supervisor Git Sync в том же home.
     */
    probeLease: (): "free" | "busy" => probeServerLease(launch),
    /**
     * Сохраняет публичный Server-контракт с native details и исходной причиной декодирования.
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
