import { GuardedCommandError } from "./errors";
import { guardianMessages } from "./guardian.messages";
import { failureStage, systemCode } from "./diagnostics";
import type {
  GuardedCommandDiagnostic,
  GuardedCommandFailureReason,
  GuardedCommandOptions,
} from "./guardian.types";
import type {
  AnchorOutcome,
  GuardianControl,
  GuardianOutput,
  GuardianRequest,
  GuardianResponse,
} from "./protocol.types";

/* Верхняя граница JSON-frame защищает ещё не проверенный запрос от неограниченной аллокации. */
export const maxRequestBytes = 256 * 1024 * 1024;
/* Общий бюджет ограничен также размером единственного ответного frame. */
export const maxCommandOutputBytes = 128 * 1024 * 1024;
/* Время на запуск служебной роли и очистку дерева сверх deadline команды. */
export const guardianGraceMs = 10_000;
/* Очистка после убийства группы не должна ждать pipe, удерживаемый посторонним процессом. */
export const treeCleanupMs = 5000;
/* Одно IPC-сообщение потокового вывода не может накапливать неограниченный журнал. */
export const maxOutputChunkBytes = 64 * 1024;

/**
 * Проверяет точный набор полей объекта на границе приватного протокола.
 */
function record(
  value: unknown,
  fields: readonly string[],
  optional: readonly string[] = [],
): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).every((key) => fields.includes(key) || optional.includes(key)) &&
    fields.every((field) => Object.hasOwn(value, field))
  );
}

/**
 * Проверяет непустую argv-команду без NUL, недопустимого в аргументах spawn.
 */
function command(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value[0] !== "" &&
    value.every((item) => typeof item === "string" && !item.includes("\0"))
  );
}

/**
 * Проверяет полное строковое окружение команды без подстановки глобального process.env.
 */
function environment(value: unknown): value is Record<string, string> {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.entries(value).every(
      ([key, item]) =>
        key.length > 0 &&
        !key.includes("=") &&
        !key.includes("\0") &&
        typeof item === "string" &&
        !item.includes("\0"),
    )
  );
}

/**
 * Отклоняет неканонический base64 вместо молчаливой потери произвольных байтов.
 */
export function binary(value: unknown): value is string {
  return typeof value === "string" && Buffer.from(value, "base64").toString("base64") === value;
}

/**
 * Проверяет причину по собственным ключам словаря, исключая свойства прототипа.
 */
export function failureReason(value: unknown): value is GuardedCommandFailureReason {
  return typeof value === "string" && Object.hasOwn(guardianMessages, value);
}

/**
 * Декодирует строгий запрос до создания любых команд и нативных ресурсов.
 */
export function decodeRequest(value: unknown): GuardianRequest {
  if (
    !record(
      value,
      [
        "version",
        "role",
        "component",
        "argv",
        "cwd",
        "env",
        "input",
        "timeoutMs",
        "maxOutputBytes",
      ],
      [
        "maxOutputBytesPerStream",
        "stdinLease",
        "strictStdout",
        "streamStdout",
        "streamStderr",
        "terminationGraceMs",
      ],
    ) ||
    value.version !== 1 ||
    (value.role !== "guardian" && value.role !== "anchor") ||
    !command(value.component) ||
    !command(value.argv) ||
    typeof value.cwd !== "string" ||
    value.cwd.length === 0 ||
    value.cwd.includes("\0") ||
    !environment(value.env) ||
    !binary(value.input) ||
    !(value.timeoutMs === null
      ? value.stdinLease === true
      : typeof value.timeoutMs === "number" &&
        Number.isInteger(value.timeoutMs) &&
        value.timeoutMs >= 1 &&
        value.timeoutMs <= 2_147_483_647) ||
    typeof value.maxOutputBytes !== "number" ||
    !Number.isInteger(value.maxOutputBytes) ||
    value.maxOutputBytes < 0 ||
    value.maxOutputBytes > maxCommandOutputBytes ||
    !["stdinLease", "strictStdout", "streamStdout", "streamStderr"].every(
      (key) => value[key] === undefined || typeof value[key] === "boolean",
    ) ||
    !(
      value.terminationGraceMs === undefined ||
      (typeof value.terminationGraceMs === "number" &&
        Number.isInteger(value.terminationGraceMs) &&
        value.terminationGraceMs >= 0 &&
        value.terminationGraceMs <= 10_000)
    ) ||
    !(
      value.maxOutputBytesPerStream === undefined ||
      (typeof value.maxOutputBytesPerStream === "number" &&
        Number.isInteger(value.maxOutputBytesPerStream) &&
        value.maxOutputBytesPerStream >= 0 &&
        value.maxOutputBytesPerStream <= value.maxOutputBytes)
    )
  ) {
    throw new GuardedCommandError("protocol");
  }
  // Поля проверены до нормализации; TypeScript не сужает целый Record по отдельным свойствам.
  return {
    ...value,
    maxOutputBytesPerStream: value.maxOutputBytesPerStream ?? value.maxOutputBytes,
    stdinLease: value.stdinLease ?? false,
    strictStdout: value.strictStdout ?? false,
    streamStdout: value.streamStdout ?? false,
    streamStderr: value.streamStderr ?? false,
    terminationGraceMs: value.terminationGraceMs ?? 0,
  } as unknown as GuardianRequest;
}

/**
 * Создаёт и проверяет переносимый запрос; undefined окружения не наследуется командой.
 */
export function createRequest(options: GuardedCommandOptions): GuardianRequest {
  return decodeRequest({
    version: 1,
    role: "guardian",
    component: options.component,
    argv: options.argv,
    cwd: options.cwd,
    env: Object.fromEntries(Object.entries(options.env).filter(([, value]) => value !== undefined)),
    input: Buffer.from(options.input ?? "").toString("base64"),
    timeoutMs: options.timeoutMs,
    maxOutputBytes: options.maxOutputBytes,
    maxOutputBytesPerStream: options.maxOutputBytesPerStream ?? options.maxOutputBytes,
    stdinLease: options.stdinLease ?? false,
    strictStdout: options.strictStdout ?? false,
    streamStdout: options.stdout !== undefined,
    streamStderr: options.stderr !== undefined,
    terminationGraceMs: options.terminationGraceMs ?? 0,
  });
}

/**
 * Проверяет ограниченный бинарный chunk до передачи пользовательскому получателю.
 */
export function decodeOutput(value: unknown): GuardianOutput {
  if (
    !record(value, ["version", "kind", "stream", "data"]) ||
    value.version !== 1 ||
    value.kind !== "output" ||
    (value.stream !== "stdout" && value.stream !== "stderr") ||
    typeof value.data !== "string" ||
    value.data.length > Math.ceil(maxOutputChunkBytes / 3) * 4 ||
    !binary(value.data) ||
    Buffer.byteLength(value.data, "base64") > maxOutputChunkBytes
  ) {
    throw new GuardedCommandError("protocol");
  }
  return { version: 1, kind: "output", stream: value.stream, data: value.data };
}

/**
 * Проверяет служебную остановку; протокол не допускает освобождения принадлежащих команде потомков.
 */
export function decodeControl(value: unknown): GuardianControl {
  if (
    record(value, ["version", "kind", "signal"], ["stdinOnly"]) &&
    value.version === 1 &&
    value.kind === "stop" &&
    (value.signal === "SIGINT" || value.signal === "SIGTERM") &&
    (value.stdinOnly === undefined || typeof value.stdinOnly === "boolean")
  ) {
    return { version: 1, kind: "stop", signal: value.signal, stdinOnly: value.stdinOnly === true };
  }
  throw new GuardedCommandError("protocol");
}

/**
 * Проверяет optional native-диагностику: код без этапа и произвольные строки запрещены.
 */
function decodeDiagnostic(
  value: Readonly<Record<string, unknown>>,
): Partial<GuardedCommandDiagnostic> {
  if (!Object.hasOwn(value, "stage")) {
    if (Object.hasOwn(value, "systemCode")) {
      throw new GuardedCommandError("protocol");
    }
    return {};
  }
  if (!failureStage(value.stage)) {
    throw new GuardedCommandError("protocol");
  }
  if (!Object.hasOwn(value, "systemCode")) {
    return { stage: value.stage };
  }
  if (!systemCode(value.systemCode)) {
    throw new GuardedCommandError("protocol");
  }
  return { stage: value.stage, systemCode: value.systemCode };
}

/**
 * Проверяет сообщение отдельного якоря; ненулевой код команды остаётся результатом.
 */
export function decodeOutcome(value: unknown): AnchorOutcome {
  if (
    record(value, ["version", "kind", "code"]) &&
    value.version === 1 &&
    value.kind === "result" &&
    typeof value.code === "number" &&
    Number.isInteger(value.code) &&
    value.code >= 0 &&
    value.code <= 0xffff_ffff
  ) {
    return { version: 1, kind: "result", code: value.code };
  }
  if (
    record(value, ["version", "kind", "reason"], ["stage", "systemCode"]) &&
    value.version === 1 &&
    value.kind === "failure" &&
    failureReason(value.reason)
  ) {
    return { version: 1, kind: "failure", reason: value.reason, ...decodeDiagnostic(value) };
  }
  throw new GuardedCommandError("protocol");
}

/**
 * Проверяет ответ, общий/отдельные бюджеты и соответствие capture-полей запрошенному streaming-режиму.
 */
export function decodeResponse(value: unknown, request: GuardianRequest): GuardianResponse {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new GuardedCommandError("protocol");
  }
  const fields =
    "kind" in value && value.kind === "result"
      ? ["version", "kind", "code", "stdout", "stderr"]
      : ["version", "kind", "reason", "stdout", "stderr"];
  const diagnosticFields =
    "kind" in value && value.kind === "failure" ? ["stage", "systemCode"] : [];
  if (!record(value, fields, diagnosticFields) || !binary(value.stdout) || !binary(value.stderr)) {
    throw new GuardedCommandError("protocol");
  }
  const { stdout, stderr, ...rest } = value;
  const outcome = decodeOutcome(rest);
  const stdoutBytes = Buffer.byteLength(stdout, "base64");
  const stderrBytes = Buffer.byteLength(stderr, "base64");
  if (
    stdoutBytes + stderrBytes > request.maxOutputBytes ||
    stdoutBytes > request.maxOutputBytesPerStream ||
    stderrBytes > request.maxOutputBytesPerStream ||
    (request.streamStdout && stdoutBytes !== 0) ||
    (request.streamStderr && stderrBytes !== 0)
  ) {
    throw new GuardedCommandError("protocol");
  }
  return { ...outcome, stdout, stderr };
}

/**
 * Вычисляет верхнюю границу base64 двух потоков с запасом только для JSON-метаданных.
 */
export function responseFrameLimit(budget: number): number {
  return Math.ceil(budget / 3) * 4 + 1024;
}
