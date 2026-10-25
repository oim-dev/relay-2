import { describe, expect, test } from "bun:test";
import { realpathSync } from "node:fs";
import { join, posix } from "node:path";
import {
  createServerClient,
  readServerLaunch,
  runNativeProcess,
  type ProcessResult,
  type ServerEnvironment,
} from "@relay/project-runtime";
import { version } from "../../package.json";
import { withCliFixture } from "./helpers/cli-fixture";
import { spawnServerTestProcess } from "./helpers/server-process";
import type { ServerTestProcess } from "./helpers/server-process.types";

/**
 * Читает единственный ExecStart в форме с кавычками, публикуемой генератором.
 * Это декодирование fixture, не эмуляция systemd: неизвестная форма отвергается.
 * Проверяет фиксированный exec-переходник и возвращает фактически опубликованный argv Server.
 */
function serverServiceArguments(content: string): string[] {
  const commands = [...content.matchAll(/^ExecStart=(.+)$/gm)];
  expect(commands).toHaveLength(1);
  const encoded = commands[0]?.[1];
  if (encoded === undefined) {
    throw new Error("В unit отсутствует ExecStart");
  }
  const tokens = encoded.match(/"(?:\\.|[^"\\])*"/g) ?? [];
  expect(tokens.join(" ")).toBe(encoded);
  const command = tokens.map((token) => {
    const value: unknown = JSON.parse(token);
    if (typeof value !== "string") {
      throw new Error("ExecStart содержит нестроковый аргумент");
    }
    return value.replaceAll("%%", "%").replaceAll("$$", "$");
  });
  expect(command.slice(0, 4)).toEqual(["/bin/sh", "-c", 'exec "$@"', "relay-server"]);
  return command.slice(4);
}

describe("Запуск Server через процессную границу Runtime", () => {
  test("native start возвращается с живым сервером, restart меняет boot, stop снимает регистрацию", async () => {
    await withCliFixture(async (cli) => {
      cli.createProject();
      const home = String(cli.runtime.env.RELAY_HOME);
      const options = { cwd: cli.runtime.cwd, home };
      const files = new Map<string, string>();
      const children: ServerTestProcess[] = [];
      const binary = realpathSync(process.execPath);
      let current: ServerTestProcess | undefined;
      let serviceId: string | undefined;
      let loadedUnit: string | undefined;
      let publishedLaunchPath: string | undefined;
      let installed = false;
      const env: ServerEnvironment = {
        cwd: cli.runtime.cwd,
        env: {},
        userHome: cli.root,
        executablePath: process.execPath,
        binary: process.execPath,
        version,
        platform: "linux",
        readinessTimeoutMs: 2000,
        serviceFiles: {
          /**
           * Хранит unit только в изолированной памяти fixture.
           */
          read: (path): string | undefined => files.get(path),
          /**
           * Публикует точное содержание unit для проверки команды manager.
           */
          write: (path, content): void => {
            files.set(path, content);
          },
          /**
           * Удаляет одну конфигурацию fixture.
           */
          remove: (path): void => {
            files.delete(path);
          },
        },
        /**
         * Подменяет manager, принимая только точные user-service команды этого unit.
         * Reload публикует конфигурацию fake-manager; enable --now использует её launch,
         * а не ищет свежий манифест в home. Все control/mutex взаимодействия — реальные процессы.
         */
        async runner(command): Promise<ProcessResult> {
          if (command.args[0] === "--version") {
            expect(command.executable).toBe(binary);
            expect(command.args).toEqual(["--version"]);
            return { exitCode: 0, stdout: `relay-server ${version}\n`, stderr: "" };
          }
          expect(command.executable).toBe("systemctl");
          if (command.args[1] === "show") {
            const selected = command.args[2];
            if (selected === undefined || selected.length === 0) {
              throw new Error("systemctl show не адресует unit");
            }
            serviceId ??= selected;
            expect(command.args).toEqual([
              "--user",
              "show",
              serviceId,
              "--property=LoadState",
              "--no-pager",
            ]);
            return {
              exitCode: loadedUnit === undefined ? 4 : 0,
              stdout: `LoadState=${loadedUnit === undefined ? "not-found" : "loaded"}\n`,
              stderr: "",
            };
          }
          if (serviceId === undefined) {
            throw new Error("Native manager вызван до выбора unit");
          }
          const unitPath = posix.join(cli.root, ".config/systemd/user", serviceId);
          if (command.args[1] === "daemon-reload") {
            expect(command.args).toEqual(["--user", "daemon-reload"]);
            loadedUnit = files.get(unitPath);
          } else if (command.args[1] === "enable") {
            expect(command.args).toEqual(["--user", "enable", "--now", serviceId]);
            expect(installed).toBe(false);
            if (loadedUnit === undefined) {
              throw new Error("Native start не опубликовал unit через daemon-reload");
            }
            const args = serverServiceArguments(loadedUnit);
            const launchPath = args[3];
            if (launchPath === undefined) {
              throw new Error("ExecStart не содержит launch path");
            }
            expect(args).toEqual([binary, "run", "--launch", launchPath]);
            publishedLaunchPath ??= launchPath;
            expect(launchPath).toBe(publishedLaunchPath);
            const launch = readServerLaunch(launchPath);
            expect(launch).toMatchObject({
              home: realpathSync(home),
              mode: "service",
              version,
              actor: "native author",
              port: 0,
            });
            current = await spawnServerTestProcess(launch);
            children.push(current);
            installed = true;
          } else if (command.args[1] === "disable") {
            expect(command.args).toEqual(["--user", "disable", "--now", serviceId]);
            expect(installed).toBe(true);
            if (current === undefined) {
              throw new Error("Native stop не имеет владельца процесса");
            }
            current.child.stdin.end();
            await current.child.exited;
            installed = false;
          } else {
            throw new Error(`Неожиданный вызов native manager: ${JSON.stringify(command.args)}`);
          }
          return { exitCode: 0, stdout: "", stderr: "" };
        },
      };
      const client = createServerClient(env);
      try {
        const started = await client.start(options, { actor: "native author", port: 0 });
        expect(started).toMatchObject({ state: "ready", mode: "service" });
        expect(current?.child.exitCode).toBeNull();
        expect(files.size).toBe(1);
        expect([...files.values()][0]).not.toContain("--parent-lease");

        const restarted = await client.restart(options, started.instanceId);

        expect(restarted).toMatchObject({
          instanceId: started.instanceId,
          state: "ready",
          mode: "service",
        });
        expect(restarted.bootId).not.toBe(started.bootId);
        expect(restarted.pid).not.toBe(started.pid);
        expect(children[0]?.child.exitCode).toBe(0);
        expect(
          readServerLaunch(join(home, "servers", started.instanceId, "launch.json")),
        ).toMatchObject({ actor: "native author", port: 0, options });

        const stopped = await client.stop(options, started.instanceId);
        expect(stopped.state).toBe("stopped");
        expect(files.size).toBe(0);
        expect(installed).toBe(false);
        expect(loadedUnit).toBeUndefined();
      } finally {
        await Promise.all(children.map((child) => child.close()));
      }
    }, "server-web/lifecycle/fixtures");
  });

  test("foreground проходит общий guardian и завершается вместе с отменой CLI", async () => {
    await withCliFixture(async (cli) => {
      cli.createProject();
      const options = { cwd: cli.runtime.cwd, home: String(cli.runtime.env.RELAY_HOME) };
      const abort = new AbortController();
      const ready = Promise.withResolvers<void>();
      let output = "";
      const env: ServerEnvironment = {
        cwd: cli.runtime.cwd,
        env: process.env,
        userHome: cli.root,
        executablePath: process.execPath,
        binary: process.execPath,
        version,
        signal: AbortSignal.any([abort.signal, AbortSignal.timeout(5000)]),
        /**
         * Событие готовности child служит барьером перед отменой, без таймерного ожидания запуска.
         */
        stdout(text): void {
          output += text;
          if (output.includes("bootId")) {
            ready.resolve();
          }
        },
        /**
         * Заменяет executable тестовым source entry; фактический foreground запускает production guardian.
         */
        async runner(command): Promise<ProcessResult> {
          if (command.args[0] === "--version") {
            return { exitCode: 0, stdout: `relay-server ${version}`, stderr: "" };
          }
          expect(command).toMatchObject({ stdinLease: true, timeoutMs: null });
          expect(command.args).toContain("--parent-lease");
          return runNativeProcess({
            ...command,
            executable: process.execPath,
            args: [join(import.meta.dir, "helpers/server.test-worker.ts"), String(command.args[2])],
          });
        },
      };
      const client = createServerClient(env);
      const running = client.run(options, {});
      try {
        await Promise.race([ready.promise, running]);
        expect(output).toContain("bootId");

        abort.abort("SIGTERM");
        await expect(running).rejects.toMatchObject({ exitCode: 143 });

        const { signal: _signal, ...observerEnvironment } = env;
        const observer = createServerClient(observerEnvironment);
        const list = await observer.list(options);
        expect(list.running).toBe(0);
        expect(list.items[0]?.state).toBe("stopped");
      } finally {
        abort.abort("SIGTERM");
        await running.catch(() => {});
      }
    }, "server-web/lifecycle/fixtures");
  });
});
