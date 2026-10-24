import { RelayError, type GitSyncRequest } from "@relay/contracts";
import type { GitSyncClient, GitSyncEnvironment } from "./client.types";
import { discoverGitSyncBinary } from "./discovery";
import { gitSyncMessages as messages } from "./git-sync.messages";
import { runNativeProcess } from "./process";
import { controlGitSyncService, gitSyncHome } from "./service";
import { validateOptions } from "../configuration/paths";
import type { GitSyncServiceStatus } from "./service.types";
import { assertGitSyncJson, encodeGitSyncRequest } from "./request";
import { correlateGitSyncRequest, correlatedTransportFailure } from "./request-correlation";
import type { ProcessResult } from "./process.types";

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
 * Создаёт ленивый процессный клиент: сама фабрика не запускает компонент и не выбирает проект.
 * Каждое обращение владеет своим ребёнком; один экземпляр кеширует только проверенный путь binary.
 */
export function createGitSyncClient(environment: GitSyncEnvironment): GitSyncClient {
  let binary: Promise<string> | undefined;
  /**
   * Разрешает совместимый компонент только перед первым действительным запуском.
   */
  const resolveBinary = (): Promise<string> => (binary ??= discoverGitSyncBinary(environment));
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
          args: ["--request"],
          cwd: environment.cwd,
          env: environment.env,
          input,
          strictStdout: true,
          timeoutMs: environment.timeoutMs ?? 120_000,
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
    /**
     * Установка требует совместимый executable; status/disable доступны после его удаления.
     */
    async service(action, options): Promise<GitSyncServiceStatus> {
      return controlGitSyncService(
        action,
        options,
        environment,
        action === "enable" ? await resolveBinary() : undefined,
      );
    },
    /**
     * Запускает foreground supervisor с точным home и stdin-lease для аварийной смерти CLI.
     */
    async supervise(options): Promise<number> {
      const home = gitSyncHome(options);
      const result = await (environment.runner ?? runNativeProcess)({
        executable: await resolveBinary(),
        args: ["supervise", "--home", home, "--parent-lease"],
        cwd: environment.cwd,
        env: environment.env,
        timeoutMs: null,
        stdinLease: true,
        ...(environment.signal ? { signal: environment.signal } : {}),
        ...(environment.stdout ? { stdout: environment.stdout } : {}),
        ...(environment.stderr ? { stderr: environment.stderr } : {}),
      });
      if (result.exitCode !== 0) {
        throw new RelayError(
          "GIT_SYNC_SUPERVISOR_FAILED",
          messages.processFailed,
          result.exitCode,
          { stderr: result.stderr },
        );
      }
      return result.exitCode;
    },
  };
}
