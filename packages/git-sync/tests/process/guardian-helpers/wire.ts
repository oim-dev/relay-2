import type { GuardedCommandOptions } from "@relay/project-runtime";

/**
 * Собирает fixture-запрос независимо от production-декодера, сохраняя публичные параметры команды.
 */
export function createRequest(options: GuardedCommandOptions): Record<string, unknown> {
  return {
    version: 1,
    role: "guardian",
    component: options.component,
    argv: options.argv,
    cwd: options.cwd,
    env: options.env,
    input: Buffer.from(options.input ?? "").toString("base64"),
    timeoutMs: options.timeoutMs,
    maxOutputBytes: options.maxOutputBytes,
  };
}

/**
 * Кодирует независимый length-prefixed JSON-frame для проверки приватной процессной границы.
 */
export function encodeFrame(value: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(value));
  const header = Buffer.alloc(4);
  header.writeUInt32BE(body.length);
  return Buffer.concat([header, body]);
}

/**
 * Проверяет конфигурацию отдельного владельца fixture перед вызовом публичного Runtime API.
 */
export function ownerOptions(value: unknown): GuardedCommandOptions {
  if (
    value === null ||
    typeof value !== "object" ||
    !("component" in value) ||
    !Array.isArray(value.component) ||
    !value.component.every((item) => typeof item === "string") ||
    !("argv" in value) ||
    !Array.isArray(value.argv) ||
    !value.argv.every((item) => typeof item === "string") ||
    !("cwd" in value) ||
    typeof value.cwd !== "string" ||
    !("env" in value) ||
    value.env === null ||
    typeof value.env !== "object" ||
    !("timeoutMs" in value) ||
    typeof value.timeoutMs !== "number" ||
    !("maxOutputBytes" in value) ||
    typeof value.maxOutputBytes !== "number"
  ) {
    throw new Error("Повреждён запрос процессной fixture");
  }
  const env: Record<string, string> = {};
  for (const [key, item] of Object.entries(value.env)) {
    if (typeof item !== "string") {
      throw new Error("Повреждено окружение процессной fixture");
    }
    env[key] = item;
  }
  return {
    component: value.component,
    argv: value.argv,
    cwd: value.cwd,
    env,
    timeoutMs: value.timeoutMs,
    maxOutputBytes: value.maxOutputBytes,
  };
}
