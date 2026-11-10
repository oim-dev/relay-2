import { RelayError, type GitSyncRequest } from "@relay/contracts";
import type { GitSyncClient, GitSyncEnvironment } from "./client.types";
import { discoverGitSyncBinary } from "./discovery";
import { gitSyncMessages as messages } from "./git-sync.messages";
import { runNativeProcess } from "./process";
import { validateOptions } from "../configuration/paths";
import { assertGitSyncJson, encodeGitSyncRequest } from "./request";
import { correlateGitSyncRequest, correlatedTransportFailure } from "./request-correlation";
import type { ProcessResult } from "./process.types";

const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;
const AUTO_REQUEST_TIMEOUT_MS = 10_000;

/**
 * Отказ проверки envelope отличается от одноимённого прикладного кода в корректном ответе компонента.
 */
class GitSyncEnvelopeError extends RelayError {
  /**
   * Сохраняет фактические process diagnostics для несогласованного ответа.
   */
  constructor(exitCode: number, stderr: string) {
    super("GIT_SYNC_PROTOCOL_ERROR", messages.invalidResponse, 1, { exitCode, stderr });
  }
}

/**
 * Сужает внешнее JSON-значение до словаря, не утверждая предметную форму data.
 */
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Проверяет версию, форму envelope и согласованность exit code, сохраняя структурированную ошибку.
 */
export function decodeGitSyncResponse(text: string, exitCode: number, stderr: string): unknown {
  let response: unknown;
  try {
    response = JSON.parse(text);
    assertGitSyncJson(response);
  } catch {
    throw new GitSyncEnvelopeError(exitCode, stderr);
  }
  if (!object(response) || response.version !== 1 || typeof response.ok !== "boolean") {
    throw new GitSyncEnvelopeError(exitCode, stderr);
  }
  if (
    response.ok === true &&
    Object.hasOwn(response, "data") &&
    Object.keys(response).every((key) => ["version", "ok", "data"].includes(key)) &&
    exitCode === 0
  ) {
    return response.data;
  }
  const error = response.error;
  if (
    response.ok === false &&
    Object.keys(response).every((key) => ["version", "ok", "error"].includes(key)) &&
    object(error) &&
    Object.keys(error).every((key) => ["code", "message", "exitCode", "details"].includes(key)) &&
    typeof error.code === "string" &&
    typeof error.message === "string" &&
    typeof error.exitCode === "number" &&
    Number.isInteger(error.exitCode) &&
    error.exitCode > 0 &&
    error.exitCode <= 255 &&
    error.exitCode === exitCode &&
    (error.details === undefined || object(error.details))
  ) {
    throw new RelayError(error.code, error.message, error.exitCode, error.details);
  }
  throw new GitSyncEnvelopeError(exitCode, stderr);
}

/**
 * Создаёт ленивый request-порт к relay --git-sync-request, без daemon/service входов.
 * Сама фабрика не запускает CLI и не выбирает проект; Git-сценарии выполняет CLI через @relay/git-sync.
 * Каждое обращение владеет своим ребёнком; один экземпляр кеширует только проверенный путь binary.
 */
export function createGitSyncClient(environment: GitSyncEnvironment): GitSyncClient {
  let binary: Promise<string> | undefined;
  /**
   * Разрешает совместимую CLI только перед первым действительным запросом.
   * Отказ не кешируется: следующее явное обращение может увидеть установленную/обновлённую CLI.
   */
  const resolveBinary = (): Promise<string> =>
    (binary ??= discoverGitSyncBinary(environment).catch((cause) => {
      binary = undefined;
      throw cause;
    }));
  return {
    /**
     * Назначает correlation до первого spawn и передаёт один JSON-запрос без транзакций CLI.
     * Прерывание process wait сохраняет ID и unknown; прежний requestId не становится новым submit.
     */
    async request(request: GitSyncRequest): Promise<unknown> {
      const prepared = correlateGitSyncRequest(request);
      const input = encodeGitSyncRequest(prepared.request);
      validateOptions(request.options);
      let result: ProcessResult;
      try {
        result = await (environment.runner ?? runNativeProcess)({
          executable: await resolveBinary(),
          args: ["--git-sync-request"],
          cwd: environment.cwd,
          env: environment.env,
          input,
          strictStdout: true,
          timeoutMs:
            request.action === "auto"
              ? Math.min(environment.timeoutMs ?? AUTO_REQUEST_TIMEOUT_MS, AUTO_REQUEST_TIMEOUT_MS)
              : (environment.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS),
          ...(environment.signal ? { signal: environment.signal } : {}),
        });
      } catch (cause) {
        throw correlatedTransportFailure(cause, prepared.correlation);
      }
      try {
        return decodeGitSyncResponse(result.stdout, result.exitCode, result.stderr);
      } catch (cause) {
        if (cause instanceof GitSyncEnvelopeError) {
          throw correlatedTransportFailure(cause, prepared.correlation);
        }
        throw cause;
      }
    },
  };
}
