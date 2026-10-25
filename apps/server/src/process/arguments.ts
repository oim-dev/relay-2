import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { RelayError } from "@relay/contracts";
import { processMessages as messages } from "./process.messages";
import type { ServerEnvironment, ServerInvocation } from "./process.types";

/**
 * Проверяет TCP-порт без coercion пустых/дробных значений до открытия проекта.
 */
function port(value: string | undefined): number {
  if (value === undefined) {
    return 3210;
  }
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) > 65535) {
    throw new RelayError("INVALID_ARGUMENT", messages.arguments, 2);
  }
  return Number(value);
}

/**
 * Проверяет полный HTTP(S) origin, исключая пути, credentials и неоднозначную нормализацию.
 */
function origins(values: readonly string[]): readonly string[] {
  for (const value of values) {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new RelayError("INVALID_ARGUMENT", messages.arguments, 2);
    }
    if (!["http:", "https:"].includes(url.protocol) || url.origin !== value) {
      throw new RelayError("INVALID_ARGUMENT", messages.arguments, 2);
    }
  }
  return [...new Set(values)];
}

/**
 * Разбирает автономные и process формы без I/O и изменения глобальной среды.
 */
export function parseInvocation(
  argv: readonly string[],
  environment: ServerEnvironment,
): ServerInvocation {
  if (argv.includes("--version")) {
    return { kind: "version" };
  }
  if (argv.includes("--help") || argv.includes("-h")) {
    return { kind: "help" };
  }
  let parsed;
  try {
    parsed = parseArgs({
      args: [...argv],
      strict: true,
      allowPositionals: true,
      options: {
        config: { type: "string" },
        home: { type: "string" },
        project: { type: "string" },
        actor: { type: "string" },
        port: { type: "string" },
        launch: { type: "string" },
        "parent-lease": { type: "boolean" },
        "allow-origin": { type: "string", multiple: true },
      },
    });
  } catch (cause) {
    const error = new RelayError("INVALID_ARGUMENT", messages.arguments, 2);
    error.cause = cause;
    throw error;
  }
  if (
    parsed.positionals.length > 1 ||
    (parsed.positionals.length === 1 && parsed.positionals[0] !== "run")
  ) {
    throw new RelayError("INVALID_ARGUMENT", messages.arguments, 2);
  }
  const value = parsed.values;
  const allowedOrigins = origins(
    value["allow-origin"] ??
      (environment.env.RELAY_WEB_ORIGIN === undefined ? [] : [environment.env.RELAY_WEB_ORIGIN]),
  );
  if (value.launch !== undefined) {
    if (
      [value.config, value.home, value.project, value.actor, value.port].some(
        (item) => item !== undefined,
      )
    ) {
      throw new RelayError("INVALID_ARGUMENT", messages.launchConflict, 2);
    }
    if (!value.launch.trim()) {
      throw new RelayError("INVALID_ARGUMENT", messages.arguments, 2);
    }
    return {
      kind: "launch",
      path: resolve(environment.cwd, value.launch),
      parentLease: value["parent-lease"] === true,
      allowedOrigins,
    };
  }
  if (value["parent-lease"]) {
    throw new RelayError("INVALID_ARGUMENT", messages.lease, 2);
  }
  const config = value.config ?? environment.env.RELAY_CONFIG;
  const actor = value.actor ?? environment.env.RELAY_ACTOR;
  return {
    kind: "direct",
    allowedOrigins,
    runtime: {
      cwd: environment.cwd,
      home:
        value.home ??
        environment.env.RELAY_HOME ??
        resolve(environment.cwd, environment.userHome, ".relay"),
      ...(config === undefined ? {} : { config }),
      ...(value.project === undefined ? {} : { project: value.project }),
    },
    input: { port: port(value.port), ...(actor === undefined ? {} : { actor }) },
  };
}
