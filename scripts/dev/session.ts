import { join } from "node:path";
import {
  createServerLaunch,
  nativeExecutableName,
  resolveServerScope,
} from "@relay/project-runtime";
import { version } from "../../package.json";
import { developmentMessages as messages } from "./dev.messages";
import { runDevelopmentProcess } from "./processes";
import { waitForDevelopment } from "./readiness";
import type { DevelopmentEnvironment, DevelopmentOptions } from "./dev.types";

/**
 * Подготавливает CLI/SDK, затем удерживает три foreground-команды одной dev-сессии.
 * Один launch передаётся всем перезапускам Bun watch. Любой выход watcher завершает соседей;
 * новый запуск сессии создаёт новый UUID. Playground никогда не инициализируется автоматически.
 * Уже отменённая сессия завершается без выбора проекта, открытия БД или запуска сборки.
 */
export async function runDevelopmentSession(
  options: DevelopmentOptions,
  environment: DevelopmentEnvironment,
): Promise<void> {
  if (environment.signal.aborted) {
    return;
  }
  const scope = resolveServerScope(options.runtime);
  if (!scope.projects.some((project) => project.available)) {
    throw new Error(messages.unavailable);
  }
  const { repository, bun } = environment;
  const cli = join(repository, "apps/cli/dist", nativeExecutableName("relay"));
  console.log(messages.preparing);
  await runDevelopmentProcess(
    "build",
    [bun, "x", "--no-install", "turbo", "run", "@relay/cli#build", "@relay/rest-sdk#build"],
    repository,
    environment,
    environment.signal,
    false,
  );
  if (environment.signal.aborted) {
    return;
  }
  const webUrl = `http://127.0.0.1:${options.webPort}`;
  const launch = createServerLaunch(options.runtime, {
    version,
    mode: "foreground",
    port: options.port,
    ...(options.actor === undefined ? {} : { actor: options.actor }),
    development: { webUrl },
  });
  const active: DevelopmentEnvironment = {
    ...environment,
    env: {
      ...environment.env,
      RELAY_HOME: launch.home,
      RELAY_CONFIG: launch.scope.configPath,
      RELAY_ACTOR: launch.actor,
      RELAY_CLI_BIN: cli,
      RELAY_API_URL: `http://127.0.0.1:${options.port}`,
      RELAY_WEB_PORT: String(options.webPort),
      RELAY_WEB_ORIGIN: webUrl,
    },
  };
  const controller = new AbortController();
  const signal = AbortSignal.any([environment.signal, controller.signal]);
  const tasks: Promise<void>[] = [];
  let readiness: Promise<void> | undefined;
  const failures = new Set<unknown>();
  console.log(messages.context(launch.scope.configPath, launch.home, cli));
  console.log(messages.starting);
  console.log(messages.managed);
  try {
    for (const [name, directory] of [
      ["CLI", "cli"],
      ["Vite", "web"],
    ] as const) {
      tasks.push(
        runDevelopmentProcess(
          name,
          [bun, "run", "dev"],
          join(repository, "apps", directory),
          active,
          signal,
          true,
        ),
      );
    }
    tasks.push(
      runDevelopmentProcess(
        "Server",
        [
          bun,
          "--watch",
          "--tsconfig-override",
          join(repository, "apps/server/tsconfig.json"),
          join(repository, "apps/server/src/main.ts"),
          "--launch",
          launch.path,
          "--parent-lease",
        ],
        options.runtime.cwd,
        active,
        signal,
        true,
      ),
    );
    readiness = waitForDevelopment(launch, active, signal);
    await Promise.race([readiness, ...tasks]);
    await Promise.race(tasks);
  } catch (error) {
    if (!environment.signal.aborted) {
      failures.add(error);
    }
  } finally {
    controller.abort("SIGTERM");
    const results = await Promise.allSettled(tasks);
    await Promise.allSettled(readiness === undefined ? [] : [readiness]);
    for (const result of results) {
      if (result.status === "rejected") {
        failures.add(result.reason);
      }
    }
  }
  if (failures.size > 0) {
    throw new AggregateError([...failures], messages.stopped);
  }
}
