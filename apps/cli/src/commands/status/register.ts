import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { inspectRelayHome } from "@relay/project-runtime";
import { version } from "../../../package.json";
import { string } from "../../input/arguments";
import { result } from "../../output/output";
import { statusCommandMessages as messages } from "../../locales/commands/status";
import { serverClient } from "../server/client";
import type { CommandRegistry } from "../../execution/registry";
import type { Result } from "../../output/output.types";
import type { RelayStatus } from "./status.types";

const environmentNames = [
  "RELAY_HOME",
  "RELAY_CONFIG",
  "RELAY_ACTOR",
  "RELAY_CLI_BIN",
  "RELAY_SERVER_BIN",
  "RELAY_API_URL",
  "RELAY_WEB_PORT",
  "RELAY_WEB_ORIGIN",
] as const;

/**
 * Возвращает физический исполняемый файл; тестовый/встраиваемый вызов может не иметь executablePath.
 * Отсутствие файла сохраняет переданный абсолютный путь для диагностики, а не запускает PATH discovery.
 */
function executable(path: string | undefined, cwd: string): string | null {
  if (path === undefined) {
    return null;
  }
  const absolute = resolve(cwd, path);
  try {
    return realpathSync(absolute);
  } catch {
    return absolute;
  }
}

/**
 * Регистрирует глобальную readonly-сводку без обязательного проекта и автоматического Git-обмена.
 */
export function registerStatusCommand(registry: CommandRegistry): void {
  registry.addProcess("status", {
    ...messages.command,
    args: { home: string(messages.home) },
    presentation: "relay-status",
    /**
     * Один раз проверяет серверный реестр, затем перечисляет home независимо от текущего выбора.
     */
    run: async (invocation): Promise<Result> => {
      const options = {
        ...invocation.options,
        ...(invocation.values.home === undefined ? {} : { home: invocation.text("home") }),
      };
      const servers = await serverClient(invocation).list({
        cwd: options.cwd,
        ...(options.home === undefined ? {} : { home: options.home }),
      });
      const home = inspectRelayHome(
        options,
        servers.items.flatMap((item) => (item.scope ? [item.scope.configPath] : [])),
      );
      const status: RelayStatus = {
        version: 1,
        ...home,
        cli: {
          version,
          executablePath: executable(invocation.runtime.executablePath, invocation.runtime.cwd),
        },
        environment: Object.fromEntries(
          environmentNames.map((name) => [name, invocation.runtime.env[name] ?? null]),
        ),
        servers,
      };
      return result(status);
    },
  });
}
