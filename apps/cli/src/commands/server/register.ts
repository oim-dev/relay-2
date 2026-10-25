import type { RuntimeOptions, ServerStartInput } from "@relay/project-runtime";
import type { LocalInvocation } from "../../execution/local-invocation";
import type { CommandRegistry } from "../../execution/registry";
import { integer, string } from "../../input/arguments";
import { serverCommandMessages as messages } from "../../locales/commands/server";
import { result } from "../../output/output";
import type { Result } from "../../output/output.types";
import { serverClient } from "./client";

/**
 * Передаёт явный --home поверх RELAY_HOME; остальные параметры выбора сохраняются дословно.
 */
function options(invocation: LocalInvocation): RuntimeOptions {
  return {
    ...invocation.options,
    ...(invocation.values.home !== undefined ? { home: invocation.text("home") } : {}),
  };
}

/**
 * Сохраняет необязательного автора и порт без чтения stdin или открытия проекта в CLI.
 */
function startInput(invocation: LocalInvocation): ServerStartInput {
  const actor = invocation.values.actor ?? invocation.runtime.env.RELAY_ACTOR;
  return {
    ...(actor !== undefined ? { actor: String(actor) } : {}),
    ...(invocation.values.port !== undefined ? { port: Number(invocation.values.port) } : {}),
  };
}

/**
 * Регистрирует управление отдельным relay-server через Project Runtime; help/version автономны.
 */
export function registerServerCommands(registry: CommandRegistry): void {
  registry.group("server", messages.group);
  const home = { home: string(messages.home) };
  const selection = { ...home, instance: string(messages.instance) };
  registry.addProcess("server start", {
    ...messages.start,
    args: { ...home, port: integer(messages.port, 0, 65535) },
    presentation: "server-status",
    /**
     * Явно создаёт независимую пользовательскую native-службу.
     */
    run: async (i): Promise<Result> =>
      result(await serverClient(i).start(options(i), startInput(i))),
  });
  registry.addProcess("server run", {
    ...messages.run,
    args: { ...home, port: integer(messages.port, 0, 65535) },
    /**
     * Удерживает foreground через guardian до завершения или сигнала вызывающему CLI.
     */
    run: async (i): Promise<Result> => {
      await serverClient(i).run(options(i), startInput(i));
      return { data: null, silent: true };
    },
  });
  for (const [action, help] of [
    ["list", messages.list],
    ["status", messages.status],
  ] as const) {
    registry.addProcess(`server ${action}`, {
      ...help,
      args: selection,
      presentation: "server-status",
      /**
       * Выводит число подтверждённых ready и все регистрации выбранного home.
       */
      run: async (i): Promise<Result> =>
        result(
          await serverClient(i).list(
            options(i),
            i.values.instance === undefined ? undefined : i.text("instance"),
          ),
        ),
    });
  }
  for (const [action, help] of [
    ["stop", messages.stop],
    ["restart", messages.restart],
  ] as const) {
    registry.addProcess(`server ${action}`, {
      ...help,
      args: { ...home, instance: string(messages.instance, true) },
      presentation: "server-status",
      /**
       * Адресует точный UUID, не выбирая процесс по PID либо случайному проекту.
       */
      run: async (i): Promise<Result> =>
        result(await serverClient(i)[action](options(i), i.text("instance"))),
    });
  }
  registry.addProcess("server open", {
    ...messages.open,
    args: selection,
    presentation: "server-status",
    /**
     * Открывает выбранный готовый URL, сохраняя диагностику неоднозначности нескольких серверов.
     */
    run: async (i): Promise<Result> =>
      result(
        await serverClient(i).open(
          options(i),
          i.values.instance === undefined ? undefined : i.text("instance"),
        ),
      ),
  });
}
