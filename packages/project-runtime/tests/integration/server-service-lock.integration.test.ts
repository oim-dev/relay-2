import { describe, expect, test } from "bun:test";
import { dirname, join } from "node:path";
import { statSync } from "node:fs";
import { acquireLocalLock } from "@relay/storage";
import {
  createServerClient,
  createServerLaunch,
  createServerServiceConfiguration,
  initializeProject,
  type ProcessResult,
  type ServerEnvironment,
} from "@relay/project-runtime";
import { RuntimeFixture } from "./helpers/runtime-fixture";
import type { ServiceLeaseOwner } from "./helpers/service-lease-owner.types";

const states = [
  { name: "task Ready/0 без endpoint", registered: true },
  { name: "native-регистрации нет, но lease занят", registered: false },
] as const;

/**
 * Запускает настоящего владельца SQLite до явного ready; fixture убирает child даже при отказе.
 * EOF stdin освобождает lease. Child не пишет stderr; тест сохраняет и проверяет его после завершения.
 */
async function startLeaseOwner(fixture: RuntimeFixture, path: string): Promise<ServiceLeaseOwner> {
  const child = Bun.spawn(
    [process.execPath, join(import.meta.dir, "helpers/service-lease-owner.ts"), path],
    {
      cwd: fixture.cwd,
      env: { ...process.env, HOME: fixture.root, USERPROFILE: fixture.root },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      timeout: 10_000,
    },
  );
  fixture.trackChild(child);
  const errors = new Response(child.stderr).text();
  const reader = child.stdout.getReader();
  let ready = "";
  try {
    while (!ready.includes("\n")) {
      const chunk = await reader.read();
      if (chunk.done) {
        throw new Error(`Lease owner завершился до ready: ${await errors}`);
      }
      ready += new TextDecoder().decode(chunk.value);
    }
    expect(ready).toBe("ready\n");
  } finally {
    reader.releaseLock();
  }
  return { child, errors };
}

describe("Общий native stop-барьер на действующем Server owner", () => {
  test.each(states)(
    "$name запрещает cleanup до освобождения реального lifetime mutex",
    async ({ registered }) => {
      const fixture = new RuntimeFixture("project-local-sync/cli-port-review");
      try {
        initializeProject({ cwd: fixture.cwd, home: fixture.home });
        const options = { cwd: fixture.cwd, home: fixture.home };
        const launch = createServerLaunch(options, { mode: "service", version: "0.0.0" });
        const configuration = createServerServiceConfiguration({
          platform: "win32",
          binary: "C:\\Relay\\relay-server.exe",
          launch,
          userHome: "C:\\Users\\fixture",
          userName: "TEAM\\fixture",
        });
        const files = new Map([[configuration.path, configuration.content]]);
        const lockPath = join(dirname(launch.path), "ownership.sqlite");
        const { child: owner, errors } = await startLeaseOwner(fixture, lockPath);
        const inode = statSync(lockPath, { bigint: true }).ino;
        const operations: string[] = [];
        let enabled = true;
        let installed = registered;
        const environment: ServerEnvironment = {
          cwd: fixture.cwd,
          env: {},
          executablePath: process.execPath,
          userHome: "C:\\Users\\fixture",
          userName: "TEAM\\fixture",
          version: "0.0.0",
          platform: "win32",
          timeoutMs: 250,
          serviceFiles: {
            /**
             * Подменяет только файлы менеджера, не реальную SQLite ownership.
             */
            read: (path): string | undefined => files.get(path),
            /**
             * Сохраняет новый манифест только в памяти fixture.
             */
            write: (path, value): void => {
              files.set(path, value);
            },
            /**
             * Удаление своего манифеста разрешено лишь после доказанного free lease.
             */
            remove: (path): void => {
              files.delete(path);
            },
          },
          /**
           * Ready/0 и отсутствие endpoint намеренно не сопровождаются освобождением SQLite другим процессом.
           */
          async runner(command): Promise<ProcessResult> {
            if (command.executable === "powershell.exe") {
              return {
                exitCode: 0,
                stderr: "",
                stdout: JSON.stringify(
                  installed
                    ? {
                        exists: true,
                        enabled,
                        description: configuration.marker,
                        state: 3,
                        runningInstances: 0,
                      }
                    : { exists: false },
                ),
              };
            }
            expect(command.executable).toBe("schtasks.exe");
            operations.push(String(command.args[0]));
            if (command.args[0] === "/Change") {
              expect(command.args).toEqual(["/Change", "/TN", configuration.id, "/Disable"]);
              enabled = false;
            } else if (command.args[0] === "/Delete") {
              expect(command.args).toEqual(["/Delete", "/TN", configuration.id, "/F"]);
              installed = false;
            } else {
              throw new Error(`Неожиданная операция manager: ${JSON.stringify(command.args)}`);
            }
            return { exitCode: 0, stdout: "", stderr: "" };
          },
        };
        const client = createServerClient(environment);

        await expect(client.stop(options, launch.instanceId)).rejects.toMatchObject({
          code: "SERVER_SERVICE_FAILED",
          exitCode: 4,
          details: { phase: "wait-supervisor-lock", runningInstances: 0 },
        });

        expect(operations).toEqual(registered ? ["/Change"] : []);
        expect(files.get(configuration.path)).toBe(configuration.content);
        expect(() => {
          const unexpected = acquireLocalLock(lockPath);
          unexpected.release();
        }).toThrow(expect.objectContaining({ code: "LOCAL_LOCK_BUSY" }));
        owner.stdin.end();
        expect(await owner.exited).toBe(0);
        expect(await errors).toBe("");

        const stopped = await client.stop(options, launch.instanceId);

        expect(stopped.state).toBe("stopped");
        expect(operations).toEqual(registered ? ["/Change", "/Delete"] : []);
        expect(files.size).toBe(0);
        expect(statSync(lockPath, { bigint: true }).ino).toBe(inode);
      } finally {
        await fixture.dispose();
      }
    },
  );
});
