import type { ProjectLocation, RuntimeOptions } from "@relay/project-runtime";
import { workerMessages } from "./worker.messages";
import type {
  InitializationResult,
  InitializationWorkerInput,
  RegistrationWorkerInput,
} from "./worker.types";

/**
 * Сужает внешнее JSON-значение перед проверкой протокола тестовых процессов.
 */
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Проверяет передаваемый между процессами контекст, оставляя предметные ограничения Runtime.
 */
function isRuntimeOptions(value: unknown): value is RuntimeOptions {
  return (
    isObject(value) &&
    typeof value.cwd === "string" &&
    (value.home === undefined || typeof value.home === "string") &&
    (value.config === undefined || typeof value.config === "string") &&
    (value.project === undefined || typeof value.project === "string")
  );
}

/**
 * Читает обязательный аргумент JSON, не утверждая его форму до проверки.
 */
function readWorkerArgument(): unknown {
  const argument = process.argv[2];
  if (argument === undefined) {
    throw new Error(workerMessages.missingInput);
  }
  return JSON.parse(argument);
}

/**
 * Проверяет форму параметров отдельного init и необязательного ограничения HOME.
 */
export function readInitializationInput(): InitializationWorkerInput {
  const input = readWorkerArgument();
  if (
    !isObject(input) ||
    !isRuntimeOptions(input) ||
    (input.expectedHome !== undefined && typeof input.expectedHome !== "string") ||
    (input.synchronizePublication !== undefined &&
      typeof input.synchronizePublication !== "boolean")
  ) {
    throw new Error(workerMessages.invalidInitializationInput);
  }
  return {
    ...input,
    ...(input.expectedHome === undefined ? {} : { expectedHome: input.expectedHome }),
    ...(input.synchronizePublication === undefined
      ? {}
      : { synchronizePublication: input.synchronizePublication }),
  };
}

/**
 * Проверяет параметры писателя или читателя workspace, включая конечное число операций.
 */
export function readRegistrationInput(): RegistrationWorkerInput {
  const input = readWorkerArgument();
  if (
    !isObject(input) ||
    !isRuntimeOptions(input) ||
    typeof input.config !== "string" ||
    typeof input.target !== "string" ||
    typeof input.prefix !== "string" ||
    typeof input.count !== "number" ||
    !Number.isSafeInteger(input.count) ||
    input.count < 1 ||
    (input.action !== "register" && input.action !== "unregister" && input.action !== "read")
  ) {
    throw new Error(workerMessages.invalidRegistrationInput);
  }
  return {
    ...input,
    config: input.config,
    target: input.target,
    prefix: input.prefix,
    count: input.count,
    action: input.action,
  };
}

/**
 * Проверяет структуру пути опубликованного проекта на границе stdout дочернего процесса.
 */
function isProjectLocation(value: unknown): value is ProjectLocation {
  return (
    isObject(value) &&
    typeof value.projectId === "string" &&
    typeof value.databasePath === "string" &&
    typeof value.configPath === "string"
  );
}

/**
 * Декодирует ответ init без приведения неизвестного JSON к успешному результату.
 */
export function readInitializationResult(stdout: string): InitializationResult {
  const result: unknown = JSON.parse(stdout);
  if (isObject(result)) {
    if (result.kind === "success" && isProjectLocation(result.location)) {
      return { kind: "success", location: result.location };
    }
    if (result.kind === "failure" && typeof result.code === "string") {
      return { kind: "failure", code: result.code };
    }
  }
  throw new Error(workerMessages.invalidInitializationResult);
}

/**
 * Проверяет, что конкурентный читатель получил целый документ ожидаемой формы.
 */
export function validateWorkspaceSnapshot(value: unknown): void {
  if (!isObject(value) || value.version !== 1 || !Array.isArray(value.projects)) {
    throw new Error(workerMessages.incompleteWorkspace);
  }
}
