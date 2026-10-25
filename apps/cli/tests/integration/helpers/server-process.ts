import { join } from "node:path";
import type { ServerLaunch } from "@relay/project-runtime";
import type { ServerTestProcess } from "./server-process.types";

/**
 * Дочитывает уже начатый stdout; Response не принимает disturbed stream после ready-барьера.
 */
async function drainOutput(stream: ReadableStream<Uint8Array>): Promise<void> {
  const reader = stream.getReader();
  try {
    while (!(await reader.read()).done) {
      // Остальной диагностический вывод не участвует в синхронизации fixture.
    }
  } finally {
    reader.releaseLock();
  }
}

/**
 * Запускает настоящий Bun-процесс Runtime registration и ждёт событие публикации, а не произвольный sleep.
 * stdin удерживается как parent lease; helper всегда убирает процесс при отказе запуска.
 */
export async function spawnServerTestProcess(launch: ServerLaunch): Promise<ServerTestProcess> {
  const child = Bun.spawn(
    [process.execPath, join(import.meta.dir, "server.test-worker.ts"), launch.path],
    {
      cwd: launch.options.cwd,
      env: { ...process.env, HOME: launch.home, RELAY_HOME: launch.home },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const stderr = new Response(child.stderr).text();
  const reader = child.stdout.getReader();
  const deadline = setTimeout(() => child.kill(), 5000);
  try {
    const first = await reader.read();
    if (first.done || !new TextDecoder().decode(first.value).includes(launch.instanceId)) {
      throw new Error(`Сервер не опубликовал ready: ${await stderr}`);
    }
  } catch (cause) {
    child.kill();
    await child.exited;
    throw cause;
  } finally {
    clearTimeout(deadline);
    reader.releaseLock();
  }
  const stdout = drainOutput(child.stdout);
  return {
    child,
    stderr,
    /**
     * Завершает только процесс fixture по handle и дожидается закрытия потоков.
     */
    async close(): Promise<void> {
      if (child.exitCode === null) {
        child.kill();
      }
      await child.exited;
      await Promise.all([stderr, stdout]);
    },
  };
}
