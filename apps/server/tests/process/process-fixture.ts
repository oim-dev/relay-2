import { mkdir, mkdtemp, rm, copyFile, chmod } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createServerClient, nativeExecutableName } from "@relay/project-runtime";
import { version } from "../../package.json";
import type { ServerChild, ServerReady } from "./process-fixture.types";

/**
 * Ожидает событие с deadline; таймер снимается при любом результате.
 */
export async function deadline<T>(promise: Promise<T>, timeoutMs = 15000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("Превышен deadline процесса")), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Создаёт отдельный каталог и копию продукта; cleanup не затрагивает shared checkout/dist.
 */
export async function withBinary(
  action: (directory: string, binary: string) => Promise<void>,
): Promise<void> {
  const root = resolve(
    import.meta.dir,
    "../../../../.artifacts",
    new Date().toISOString().slice(0, 10),
    "server-web/nest-server/process",
  );
  await mkdir(root, { recursive: true });
  const directory = await mkdtemp(join(root, "binary-"));
  const binary = join(directory, nativeExecutableName("relay-server"));
  try {
    await copyFile(
      resolve(import.meta.dir, "../../dist", nativeExecutableName("relay-server")),
      binary,
    );
    await chmod(binary, 0o755);
    await action(directory, binary);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/**
 * Проверяет единственное ready-сообщение без утверждения непроверенной JSON формы.
 */
function readyMessage(text: string): ServerReady {
  const value: unknown = JSON.parse(text);
  if (
    value === null ||
    typeof value !== "object" ||
    !("event" in value) ||
    value.event !== "ready" ||
    !("url" in value) ||
    typeof value.url !== "string" ||
    !("instanceId" in value) ||
    typeof value.instanceId !== "string" ||
    !("bootId" in value) ||
    typeof value.bootId !== "string"
  ) {
    throw new Error("Некорректное ready сообщение");
  }
  return { url: value.url, instanceId: value.instanceId, bootId: value.bootId };
}

/**
 * Запускает настоящий binary с явной средой; оба потока читаются параллельно весь lifetime.
 * HOME и RELAY_HOME обязательны: control-stop адресует тот же изолированный реестр.
 * При ошибке readiness сам завершает принадлежащий процесс; после успеха это обязанность caller.
 */
export async function startChild(
  binary: string,
  cwd: string,
  args: readonly string[],
  env: Record<string, string | undefined>,
): Promise<ServerChild> {
  const home = env.RELAY_HOME;
  const userHome = env.HOME;
  if (home === undefined || !home.trim() || userHome === undefined || !userHome.trim()) {
    throw new Error("Процессной fixture нужны явные HOME и RELAY_HOME");
  }
  const client = createServerClient({ cwd, env, userHome, executablePath: binary, version });
  const child = Bun.spawn([binary, ...args], {
    cwd,
    env,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  const ready = Promise.withResolvers<ServerReady>();
  const stderr = new Response(child.stderr).text();
  const stdout = (async (): Promise<string> => {
    const reader = child.stdout.getReader();
    const decoder = new TextDecoder();
    let text = "";
    let reported = false;
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) {
          break;
        }
        text += decoder.decode(chunk.value, { stream: true });
        if (!reported && text.includes("\n")) {
          ready.resolve(readyMessage(text.slice(0, text.indexOf("\n"))));
          reported = true;
        }
      }
      if (!reported) {
        ready.reject(new Error(`Server завершился до ready: ${await stderr}`));
      }
      return text;
    } catch (error) {
      ready.reject(error);
      throw error;
    } finally {
      reader.releaseLock();
    }
  })();
  try {
    const published = await deadline(ready.promise);
    return {
      process: child,
      ready: published,
      stdout,
      stderr,
      /**
       * Использует публичный control-клиент и UUID готового child; PID не становится целью сигнала.
       */
      async stopGracefully(): Promise<void> {
        await client.stop({ cwd, home }, published.instanceId);
      },
    };
  } catch (error) {
    child.kill("SIGKILL");
    await Promise.allSettled([child.exited, stdout, stderr]);
    throw error;
  }
}

/**
 * Штатно останавливает живой child через control; SIGKILL остаётся страховкой после отказа.
 * Уже завершившийся процесс сохраняет проверяемый caller код, включая намеренный exit 124.
 * Ошибки остановки и drain сохраняются вместе, принудительная уборка не становится успехом.
 */
export async function stopChild(child: ServerChild): Promise<void> {
  const failures: unknown[] = [];
  if (child.process.exitCode === null && child.process.signalCode === null) {
    try {
      await deadline(child.stopGracefully());
      const code = await deadline(child.process.exited);
      if (code !== 0) {
        throw new Error(`Нештатное завершение Server после control-stop: exit ${code}`);
      }
    } catch (error) {
      failures.push(error);
      if (child.process.exitCode === null && child.process.signalCode === null) {
        try {
          child.process.kill("SIGKILL");
          await deadline(child.process.exited, 5000);
        } catch (cleanup) {
          failures.push(cleanup);
        }
      }
    }
  }
  try {
    const streams = await deadline(Promise.allSettled([child.stdout, child.stderr]), 5000);
    for (const stream of streams) {
      if (stream.status === "rejected") {
        failures.push(stream.reason);
      }
    }
  } catch (error) {
    failures.push(error);
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, "Не удалось штатно завершить Server fixture");
  }
}
