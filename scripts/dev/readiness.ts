import { setTimeout as pause } from "node:timers/promises";
import { probeServerInstance, type ServerLaunch } from "@relay/project-runtime";
import { developmentMessages as messages } from "./dev.messages";
import type { DevelopmentEnvironment } from "./dev.types";

/**
 * Ожидает живой control конкретного launch и Vite client, не принимая файл реестра за readiness.
 * Poll ограничен стартовым deadline и общей отменой; ошибки наблюдения не перезапускают команды.
 */
export async function waitForDevelopment(
  launch: ServerLaunch,
  environment: DevelopmentEnvironment,
  signal: AbortSignal,
): Promise<void> {
  const webUrl = launch.development?.webUrl;
  if (webUrl === undefined) {
    throw new Error(messages.readiness("Vite"));
  }
  const deadline = performance.now() + 30_000;
  let apiReady = false;
  let webReady = false;
  while (!signal.aborted && performance.now() < deadline) {
    const status = await probeServerInstance(launch, {
      cwd: launch.options.cwd,
      env: environment.env,
      userHome: launch.home,
      executablePath: environment.bun,
      version: launch.version,
      signal,
      timeoutMs: 500,
    });
    apiReady = status.state === "ready";
    try {
      const response = await fetch(new URL("/@vite/client", webUrl), {
        signal: AbortSignal.any([signal, AbortSignal.timeout(500)]),
        redirect: "error",
      });
      webReady = response.ok && (await response.text()).includes("WebSocket");
    } catch {
      webReady = false;
    }
    if (apiReady && webReady && status.url !== null) {
      console.log(messages.ready(launch.instanceId, status.url, webUrl));
      return;
    }
    await pause(100, undefined, { signal });
  }
  signal.throwIfAborted();
  throw new Error(messages.readiness(apiReady ? "Vite" : "Server"));
}
