import { copyFile, cp, mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { ServerLaunch } from "@relay/project-runtime";
import { deadline } from "../process/process-fixture";
import type { ServerReady } from "../process/process-fixture.types";
import type { DevelopmentServer, DevelopmentSource } from "./development-fixture.types";

/**
 * Копирует только Server, без build и Web dist. Зависимости доступны по ссылке и не изменяются;
 * изменение entry для reload не затрагивает рабочее дерево или соседние тесты.
 * Callback обязан освободить свои процессы до удаления каталога в finally.
 */
export async function withDevelopmentSource(
  action: (source: DevelopmentSource) => Promise<void>,
): Promise<void> {
  const repository = resolve(import.meta.dir, "../../../..");
  const artifacts = join(
    repository,
    ".artifacts",
    new Date().toISOString().slice(0, 10),
    "dev-mode-test-review/fixtures",
  );
  await mkdir(artifacts, { recursive: true });
  const directory = await mkdtemp(join(artifacts, "source-"));
  const serverDirectory = join(directory, "apps/server");
  try {
    const original = join(repository, "apps/server");
    await cp(join(original, "src"), join(serverDirectory, "src"), { recursive: true });
    await copyFile(join(original, "package.json"), join(serverDirectory, "package.json"));
    await copyFile(join(original, "tsconfig.json"), join(serverDirectory, "tsconfig.json"));
    await copyFile(join(original, "openapi.json"), join(serverDirectory, "openapi.json"));
    await symlink(
      join(original, "node_modules"),
      join(serverDirectory, "node_modules"),
      "junction",
    );
    await action({ directory, serverDirectory });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/**
 * Декодирует наблюдаемый процессный контракт, не объявляя непроверенный JSON типизированным ready.
 */
function readyMessage(line: string): ServerReady {
  const value: unknown = JSON.parse(line);
  if (
    value === null ||
    typeof value !== "object" ||
    !("event" in value) ||
    value.event !== "ready" ||
    !("instanceId" in value) ||
    typeof value.instanceId !== "string" ||
    !("bootId" in value) ||
    typeof value.bootId !== "string" ||
    !("url" in value) ||
    typeof value.url !== "string"
  ) {
    throw new Error(`Некорректное ready-событие Server: ${line}`);
  }
  return { instanceId: value.instanceId, bootId: value.bootId, url: value.url };
}

/**
 * Непрерывно читает stdout, разделяя JSON-события по строкам, а не по произвольным pipe chunks.
 * Технические строки Bun watch не являются ready. Ошибка передаётся ожидающему событие и cleanup.
 */
async function collectReadyEvents(
  stream: ReadableStream<Uint8Array>,
  events: ReadableStreamDefaultController<ServerReady>,
): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let pending = "";
  try {
    for (;;) {
      const chunk = await reader.read();
      pending += chunk.done ? decoder.decode() : decoder.decode(chunk.value, { stream: true });
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines) {
        if (line.startsWith("{")) {
          events.enqueue(readyMessage(line));
        }
      }
      if (chunk.done) {
        if (pending.trim() !== "") {
          throw new Error(`Незавершённая строка stdout Server: ${pending}`);
        }
        events.close();
        return;
      }
    }
  } catch (cause) {
    events.error(cause);
    throw cause;
  } finally {
    reader.releaseLock();
  }
}

/**
 * Запускает source entry с настоящими --watch и --parent-lease вне checkout/cwd Server.
 * Ни compiled binary, ни готовые Web assets не используются. Caller всегда вызывает dispose.
 */
export function startDevelopmentServer(
  source: DevelopmentSource,
  launch: ServerLaunch,
): DevelopmentServer {
  const child = Bun.spawn(
    [
      process.execPath,
      "--watch",
      "--tsconfig-override",
      join(source.serverDirectory, "tsconfig.json"),
      join(source.serverDirectory, "src/main.ts"),
      "--launch",
      launch.path,
      "--parent-lease",
    ],
    {
      cwd: launch.options.cwd,
      env: {
        HOME: source.directory,
        USERPROFILE: source.directory,
        RELAY_HOME: launch.home,
        PATH: "",
      },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const stderr = new Response(child.stderr).text();
  let stdout = Promise.resolve();
  const events = new ReadableStream<ServerReady>({
    /**
     * Начинает drain сразу, не только во время ожидания очередного ready.
     */
    start(controller): void {
      stdout = collectReadyEvents(child.stdout, controller);
    },
  }).getReader();
  const completion = Promise.allSettled([child.exited, stdout, stderr]);
  return {
    child,
    stderr,
    /**
     * Каждый вызов потребляет новое событие; EOF и deadline являются ошибками, а не readiness.
     */
    async nextReady(): Promise<ServerReady> {
      const event = await deadline(events.read(), 10_000);
      if (event.done) {
        throw new Error(`Server завершился до следующего ready: ${await stderr}`);
      }
      return event.value;
    },
    /**
     * Завершает только собственный процесс; не использует PID из реестра и не маскирует ошибки drain.
     */
    async dispose(): Promise<void> {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
      try {
        const results = await deadline(completion, 5000);
        const failures = results.flatMap((result) =>
          result.status === "rejected" ? [result.reason] : [],
        );
        if (failures.length > 0) {
          throw new AggregateError(failures, "Не удалось завершить source Server fixture");
        }
      } finally {
        events.releaseLock();
      }
    },
  };
}
