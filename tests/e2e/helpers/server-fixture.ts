import { createRelayClient } from "@relay/rest-sdk";
import { nativeExecutableName } from "@relay/project-runtime";
import { chmod, copyFile, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { WorkflowEnvironment } from "../../../apps/cli/tests/e2e/helpers/workflow-fixture.types";
import { invokeSuccess } from "../../../apps/cli/tests/e2e/helpers/workflow-fixture";
import type { WorkflowServer, WorkflowServerReady } from "./server-fixture.types";

const source = resolve(
  import.meta.dir,
  "../../../apps/server/dist",
  nativeExecutableName("relay-server"),
);
const readinessDeadlineMs = 30_000;
const requestDeadlineMs = 30_000;
const gracefulDeadlineMs = 30_000;
const forcedExitDeadlineMs = 5_000;
const drainDeadlineMs = 5_000;
const outputMaxBytes = 1024 * 1024;

/**
 * Сохраняет причины неполной или нештатной очистки; caller оставляет файлы fixture для диагностики.
 */
export class WorkflowServerCleanupError extends AggregateError {
  /**
   * Собирает исходные ошибки, не подменяя отказ запуска последующей ошибкой cleanup.
   */
  constructor(errors: readonly unknown[], directory: string) {
    super(errors, `Не удалось штатно освободить Server fixture; файлы сохранены: ${directory}`);
    this.name = "WorkflowServerCleanupError";
  }
}

/**
 * Ограничивает конкретную фазу ожидания; таймер всегда снимается, исходный отказ не поглощается.
 */
async function withinDeadline<T>(
  pending: Promise<T>,
  milliseconds: number,
  message: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      pending,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Принимает полный JSON-ready с loopback URL и UUID регистрации для control-stop.
 * Отдельный URL и диагностические строки не дают идентичность принадлежащего fixture запуска.
 */
function publishedServer(line: string): WorkflowServerReady | undefined {
  try {
    const value: unknown = JSON.parse(line);
    if (
      value === null ||
      typeof value !== "object" ||
      !("event" in value) ||
      value.event !== "ready" ||
      !("url" in value) ||
      typeof value.url !== "string" ||
      !("instanceId" in value) ||
      typeof value.instanceId !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(value.instanceId)
    ) {
      return undefined;
    }
    const url = new URL(value.url);
    if (
      url.protocol === "http:" &&
      url.hostname === "127.0.0.1" &&
      Number(url.port) > 0 &&
      url.pathname === "/" &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash
    ) {
      return { url: url.origin, instanceId: value.instanceId };
    }
  } catch {
    // Обычная строка диагностики не является readiness-событием.
  }
  return undefined;
}

/**
 * Дренирует принадлежащий fixture reader с ограничением памяти и строгим UTF-8.
 * Callback видит только полные строки; releaseLock выполняется и при отказе чтения.
 */
async function readServerOutput(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  onLine?: (line: string) => void,
): Promise<string> {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0;
  let text = "";
  let consumed = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) {
        return text + decoder.decode();
      }
      bytes += chunk.value.byteLength;
      if (bytes > outputMaxBytes) {
        throw new Error("Вывод Server превысил лимит диагностики fixture");
      }
      text += decoder.decode(chunk.value, { stream: true });
      let boundary = text.indexOf("\n", consumed);
      while (boundary !== -1) {
        onLine?.(text.slice(consumed, boundary));
        consumed = boundary + 1;
        boundary = text.indexOf("\n", consumed);
      }
    }
  } finally {
    reader.releaseLock();
  }
}

/**
 * Копирует только бинарник в отдельный каталог и запускает его с изолированным HOME.
 * Готовность определяется опубликованными URL и UUID, а не произвольной задержкой.
 * При отказе запуска самостоятельно завершает процесс; после успеха close обязателен.
 * Нештатный exit, принудительное завершение и незакрытые потоки не становятся успешным cleanup.
 */
export async function startWorkflowServer(
  environment: WorkflowEnvironment,
  cwd: string,
): Promise<WorkflowServer> {
  const directory = join(environment.root, `server-${crypto.randomUUID()}`);
  await mkdir(directory);
  const executable = join(directory, nativeExecutableName("relay-server"));
  await copyFile(source, executable);
  await chmod(executable, 0o755);
  const child = Bun.spawn([executable, "--port", "0"], {
    cwd,
    env: environment.variables,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const ready = Promise.withResolvers<WorkflowServerReady>();
  let published: WorkflowServerReady | undefined;
  const requests = new AbortController();
  const stdoutReader = child.stdout.getReader();
  const stderrReader = child.stderr.getReader();
  const openReaders = new Set([stdoutReader, stderrReader]);
  const stdout = readServerOutput(stdoutReader, (line) => {
    if (published === undefined) {
      published = publishedServer(line);
      if (published !== undefined) {
        ready.resolve(published);
      }
    }
  }).finally(() => openReaders.delete(stdoutReader));
  const stderr = readServerOutput(stderrReader).finally(() => openReaders.delete(stderrReader));
  // Наблюдение ошибок устанавливается сразу: rejected stream не ждёт последующего close.
  const output = Promise.allSettled([stdout, stderr]);
  void stdout.then(
    () => ready.reject(new Error("stdout Server закрылся до публикации ready")),
    (error: unknown) => ready.reject(error),
  );
  void stderr.catch((error: unknown) => ready.reject(error));
  let closing: Promise<void> | undefined;
  let exitObserved = false;
  let unexpectedExit: Error | undefined;
  void child.exited.then(
    (code) => {
      exitObserved = true;
      if (closing === undefined) {
        unexpectedExit = new Error(`Server завершился до запроса close: exit ${code}`);
      }
      ready.reject(new Error(`Server завершился до готовности: exit ${code}`));
    },
    (error: unknown) => ready.reject(error),
  );

  /**
   * CLI адресует UUID в том же HOME через authenticated control, затем ожидается собственный child.
   * Stop независим от отменённых HTTP-запросов fixture; его отказ сохраняет диагностику CLI.
   */
  async function stopGracefully(): Promise<void> {
    if (published === undefined) {
      throw new Error("Server не опубликовал UUID для control-stop");
    }
    const stopped = await invokeSuccess(environment, cwd, [
      "server",
      "stop",
      "--instance",
      published.instanceId,
    ]);
    if (
      stopped === null ||
      typeof stopped !== "object" ||
      !("instanceId" in stopped) ||
      stopped.instanceId !== published.instanceId ||
      !("state" in stopped) ||
      stopped.state !== "stopped"
    ) {
      throw new Error("CLI не подтвердил остановку своей регистрации Server");
    }
    await child.exited;
  }

  /**
   * Ограниченно ждёт control-stop, fallback SIGKILL и drain отдельно.
   * После отказа control сигнал адресует только собственный child handle, не PID из stdout или файлов.
   * Ошибки потоков не прерывают попытку завершения процесса и сохраняются вместе с её исходом.
   */
  async function close(): Promise<void> {
    closing ??= (async (): Promise<void> => {
      requests.abort(new Error("Server fixture завершает HTTP-запросы"));
      const failures: unknown[] = [];
      if (unexpectedExit !== undefined) {
        failures.push(unexpectedExit);
      }
      if (!exitObserved) {
        try {
          await withinDeadline(
            stopGracefully(),
            gracefulDeadlineMs,
            "Server не завершился после control-stop",
          );
        } catch (error) {
          failures.push(error);
        }
        if (!exitObserved) {
          try {
            child.kill("SIGKILL");
            await withinDeadline(
              child.exited,
              forcedExitDeadlineMs,
              "Выход Server после SIGKILL не подтверждён",
            );
          } catch (error) {
            failures.push(error);
          }
        }
      }
      if (child.exitCode !== 0) {
        failures.push(
          new Error(
            `Нештатное завершение Server: exit ${child.exitCode}, signal ${child.signalCode}`,
          ),
        );
      }
      try {
        const streams = await withinDeadline(
          output,
          drainDeadlineMs,
          "Потоки Server не закрылись после завершения",
        );
        for (const stream of streams) {
          if (stream.status === "rejected") {
            failures.push(stream.reason);
          }
        }
        if (failures.length > 0) {
          const diagnostics = streams
            .flatMap((stream) => (stream.status === "fulfilled" ? [stream.value] : []))
            .join("\n");
          failures.push(new Error(`Диагностика Server:\n${diagnostics}`));
        }
      } catch (error) {
        failures.push(error);
        // Cancel освобождает наши чтения, но не выдаётся за подтверждённый EOF чужого потомка.
        const cancelled = Promise.allSettled([...openReaders].map((reader) => reader.cancel()));
        try {
          const results = await withinDeadline(
            cancelled,
            drainDeadlineMs,
            "Отмена чтения потоков Server не завершилась",
          );
          for (const result of results) {
            if (result.status === "rejected") {
              failures.push(result.reason);
            }
          }
        } catch (cause) {
          failures.push(cause);
        }
      }
      if (failures.length > 0) {
        throw new WorkflowServerCleanupError(failures, directory);
      }
    })();
    await closing;
  }

  /**
   * Ограничивает каждый HTTP-вызов и отменяет его при close, не повторяя запросы.
   */
  function fetchWithDeadline(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const signals = [requests.signal, AbortSignal.timeout(requestDeadlineMs)];
    if (init?.signal) {
      signals.push(init.signal);
    } else if (input instanceof Request) {
      signals.push(input.signal);
    }
    return fetch(input, { ...init, signal: AbortSignal.any(signals) });
  }

  try {
    const { url } = await withinDeadline(
      ready.promise,
      readinessDeadlineMs,
      "Server не опубликовал ready с URL и UUID",
    );
    return {
      url,
      // Bun добавляет статические свойства fetch; SDK использует только сам вызов.
      client: createRelayClient({ baseUrl: url, fetch: Object.assign(fetchWithDeadline, fetch) }),
      fetch: fetchWithDeadline,
      close,
    };
  } catch (error) {
    try {
      await close();
    } catch (cleanupError) {
      throw new WorkflowServerCleanupError([error, cleanupError], directory);
    }
    throw error;
  }
}
