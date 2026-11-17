import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { developmentMessages as messages } from "./dev.messages";
import type { DevelopmentOptions } from "./dev.types";

/**
 * Проверяет ненулевой фиксированный порт: origin и Vite proxy известны до запуска процессов.
 */
function port(value: string | undefined, fallback: number): number {
  if (value === undefined) {
    return fallback;
  }
  if (!/^[0-9]+$/.test(value) || Number(value) < 1 || Number(value) > 65535) {
    throw new Error(messages.arguments);
  }
  return Number(value);
}

/**
 * Разрешает внешний playground и home без исполнения .envrc и без создания/изменения данных.
 * null означает автономную справку; необязательный разделитель Bun удаляется один раз.
 */
export function parseDevelopmentArguments(
  argv: readonly string[],
  cwd: string,
  env: Readonly<Record<string, string | undefined>>,
): DevelopmentOptions | null {
  const args = argv[0] === "--" ? argv.slice(1) : argv;
  const { values } = parseArgs({
    args: [...args],
    strict: true,
    allowPositionals: false,
    options: {
      playground: { type: "string" },
      home: { type: "string" },
      actor: { type: "string" },
      port: { type: "string" },
      "web-port": { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help) {
    return null;
  }
  const playground = values.playground ?? "../playground";
  const home = values.home ?? env.RELAY_HOME;
  if (!playground.trim() || (home !== undefined && !home.trim())) {
    throw new Error(messages.arguments);
  }
  const directory = resolve(cwd, playground);
  const apiPort = port(values.port, 3210);
  const webPort = port(values["web-port"], 5174);
  if (apiPort === webPort) {
    throw new Error(messages.arguments);
  }
  const actor = values.actor ?? env.RELAY_ACTOR;
  return {
    runtime: {
      cwd: directory,
      home: home === undefined ? resolve(directory, "../.relay-home") : resolve(cwd, home),
    },
    ...(actor === undefined ? {} : { actor }),
    port: apiPort,
    webPort,
  };
}
