import { describe, expect, test } from "bun:test";
import { statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import {
  createGitSyncClient,
  createServiceConfiguration,
  probeGitSyncSupervisor,
  probeGitSyncSupervisorLock,
  waitForGitSyncSupervisor,
  type GitSyncEnvironment,
  type GitSyncServiceStatus,
  type GitSyncSupervisorStatus,
  type ProcessResult,
} from "@relay/project-runtime";
import { acquireLocalLock } from "@relay/storage";
import { RuntimeFixture } from "./helpers/runtime-fixture";
import type { SupervisorLockOwner } from "./helpers/supervisor-lock-fixture.types";

const group = "git-sync/service-lock";
const windowsHome = "C:\\Relay fixture\\home";
const configuration = createServiceConfiguration({
  platform: "win32",
  home: windowsHome,
  binary: "C:\\Relay fixture\\sync.exe",
  userHome: "C:\\Users\\fixture",
  userName: "TEAM\\fixture",
});

/**
 * Запускает независимого SQLite/health owner и ждёт его явный ready-барьер, без sleep.
 * RuntimeFixture владеет процессом до удаления файлов; штатный EOF проверяется в сценарии.
 */
async function startOwner(fixture: RuntimeFixture, instance: string): Promise<SupervisorLockOwner> {
  const child = Bun.spawn(
    [
      process.execPath,
      join(import.meta.dir, "helpers/supervisor-lock-owner.ts"),
      fixture.home,
      instance,
    ],
    {
      cwd: fixture.cwd,
      env: { ...process.env, HOME: fixture.root, USERPROFILE: fixture.root },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      timeout: 15_000,
    },
  );
  fixture.trackChild(child);
  const errors = new Response(child.stderr).text();
  const reader = child.stdout.getReader();
  try {
    let ready = "";
    while (!ready.includes("\n")) {
      const chunk = await reader.read();
      if (chunk.done) {
        throw new Error(`Owner завершился до readiness: ${await errors}`);
      }
      ready += new TextDecoder().decode(chunk.value);
    }
    expect(ready).toBe("ready\n");
  } finally {
    reader.releaseLock();
  }
  return { child, errors };
}

/**
 * Подменяет только расположение Windows на тестовом хосте и файлы native-регистрации.
 * Обе supervisor probes используют настоящие loopback и SQLite изолированного home.
 */
function serviceEnvironment(
  fixture: RuntimeFixture,
  files: Map<string, string>,
): GitSyncEnvironment {
  return {
    cwd: fixture.cwd,
    env: {},
    binary: process.execPath,
    executablePath: process.execPath,
    version: "0.0.0",
    platform: "win32",
    userHome: "C:\\Users\\fixture",
    userName: "TEAM\\fixture",
    timeoutMs: 5000,
    serviceFiles: {
      /**
       * Читает in-memory манифест, не обращаясь к пользовательским службам хоста.
       */
      read: (path): string | undefined => files.get(path),
      /**
       * Сохраняет публикацию native-конфигурации для проверки при отказе/успехе.
       */
      write: (path, content): void => {
        files.set(path, content);
      },
      /**
       * Удаляет только манифест собственной службы fixture.
       */
      remove: (path): void => {
        files.delete(path);
      },
    },
    /**
     * Переносит адрес между синтаксисами ОС; содержимое health остаётся настоящим.
     */
    supervisorProbe: async (_home, wait): Promise<GitSyncSupervisorStatus> =>
      (wait ? waitForGitSyncSupervisor : probeGitSyncSupervisor)(fixture.home, {
        version: "0.0.0",
        timeoutMs: 1000,
      }),
    /**
     * Проверяет тот самый mutex, который удерживает отдельный child, без подмены результата.
     */
    supervisorLockProbe: (home): "free" | "busy" => {
      expect(home).toBe(windowsHome);
      return probeGitSyncSupervisorLock(fixture.home);
    },
  };
}

describe("Windows service: передача настоящего lifetime mutex", () => {
  test.each(["enable", "disable"] as const)(
    "%s ждёт SQLite owner после Ready/no instances и снятия endpoint",
    async (action) => {
      const fixture = new RuntimeFixture(group);
      const files = new Map([[configuration.path, configuration.content]]);
      const mutations: string[] = [];
      const blocked = Promise.withResolvers<void>();
      const cancellation = new AbortController();
      let stopped = false;
      let enabled = true;
      let next: SupervisorLockOwner | undefined;
      let completed = false;
      let outcome: Promise<GitSyncServiceStatus> | undefined;
      try {
        const previous = await startOwner(fixture, "previous-instance");
        const lockPath = join(fixture.home, "git-sync/supervisor.json.ownership.sqlite");
        const inode = statSync(lockPath, { bigint: true }).ino;
        const environment: GitSyncEnvironment = {
          ...serviceEnvironment(fixture, files),
          signal: cancellation.signal,
          /**
           * Native End уже подтвердил остановку, но отдельный процесс всё ещё держит kernel lock.
           * RegistrationTrigger после Create запускает следующего owner только за production-барьером.
           */
          async runner(command): Promise<ProcessResult> {
            if (command.args[0] === "--version") {
              return { exitCode: 0, stdout: "0.0.0", stderr: "" };
            }
            if (command.executable === "schtasks.exe") {
              const operation = command.args[0] ?? "";
              mutations.push(operation);
              if (operation === "/Change") {
                expect(command.args).toEqual(["/Change", "/TN", configuration.id, "/Disable"]);
                enabled = false;
              } else if (operation === "/End") {
                expect(enabled).toBe(false);
                stopped = true;
                // ownControl также снимает endpoint раньше освобождения SQLite.
                unlinkSync(join(fixture.home, "git-sync/supervisor.json"));
              } else if (operation === "/Create") {
                expect(probeGitSyncSupervisorLock(fixture.home)).toBe("free");
                next = await startOwner(fixture, "next-instance");
                enabled = true;
                stopped = false;
              } else if (operation === "/Run") {
                throw new Error("Регистрация не должна дополняться ручным Run");
              }
              return { exitCode: 0, stdout: "", stderr: "" };
            }
            expect(command.executable).toBe("powershell.exe");
            return {
              exitCode: 0,
              stderr: "",
              stdout: JSON.stringify({
                exists: true,
                enabled,
                description: configuration.marker,
                state: stopped ? 3 : 4,
                runningInstances: stopped ? 0 : 1,
              }),
            };
          },
          /**
           * Событие синхронизирует тест после настоящего BUSY внутри production stop-цикла.
           */
          supervisorLockProbe(home): "free" | "busy" {
            expect(home).toBe(windowsHome);
            const result = probeGitSyncSupervisorLock(fixture.home);
            if (result === "busy") {
              blocked.resolve();
            }
            return result;
          },
        };
        const operation = createGitSyncClient(environment).service(action, {
          cwd: fixture.cwd,
          home: windowsHome,
        });
        // Handler прикреплён сразу: регрессия не создаёт unhandled rejection до проверки барьера.
        outcome = operation.finally(() => {
          completed = true;
        });
        await Promise.race([blocked.promise, outcome]);

        expect(completed).toBe(false);
        expect(stopped).toBe(true);
        expect(mutations).toEqual(["/Change", "/End"]);
        expect(probeGitSyncSupervisorLock(fixture.home)).toBe("busy");
        expect(() => acquireLocalLock(lockPath)).toThrow(
          expect.objectContaining({ code: "LOCAL_LOCK_BUSY" }),
        );
        expect(await probeGitSyncSupervisor(fixture.home, { version: "0.0.0" })).toMatchObject({
          actual: "stopped",
          instance: null,
        });

        previous.child.stdin.end();
        expect(await previous.child.exited).toBe(0);
        expect(await previous.errors).toBe("");
        const result = await outcome;

        expect(statSync(lockPath, { bigint: true }).ino).toBe(inode);
        if (action === "enable") {
          expect(mutations).toEqual(["/Change", "/End", "/Create"]);
          expect(result.supervisor).toMatchObject({ responsive: true, instance: "next-instance" });
          expect(result.supervisor.pid).not.toBe(previous.child.pid);
          expect(probeGitSyncSupervisorLock(fixture.home)).toBe("busy");
        } else {
          expect(mutations).toEqual(["/Change", "/End", "/Delete"]);
          expect(result).toMatchObject({ registered: false, supervisor: { responsive: false } });
          expect(files.size).toBe(0);
          expect(probeGitSyncSupervisorLock(fixture.home)).toBe("free");
        }
        if (next) {
          next.child.stdin.end();
          expect(await next.child.exited).toBe(0);
          expect(await next.errors).toBe("");
        }
      } finally {
        cancellation.abort();
        await outcome?.catch(() => {});
        await fixture.dispose();
      }
    },
    20_000,
  );

  test.each(["enable", "disable"] as const)(
    "%s не принимает живой foreground owner за остановленную native-службу",
    async (action) => {
      const fixture = new RuntimeFixture(group);
      const files = new Map([[configuration.path, configuration.content]]);
      const mutations: string[] = [];
      try {
        const foreign = await startOwner(fixture, "foreign-foreground");
        const environment: GitSyncEnvironment = {
          ...serviceEnvironment(fixture, files),
          timeoutMs: 20,
          /**
           * Native-регистрации нет: живой owner запущен независимо и не принадлежит manager.
           */
          async runner(command): Promise<ProcessResult> {
            if (command.args[0] === "--version") {
              return { exitCode: 0, stdout: "0.0.0", stderr: "" };
            }
            if (command.executable === "schtasks.exe") {
              mutations.push(command.args[0] ?? "");
            }
            return { exitCode: 0, stdout: '{"exists":false}', stderr: "" };
          },
        };

        await expect(
          createGitSyncClient(environment).service(action, { cwd: fixture.cwd, home: windowsHome }),
        ).rejects.toMatchObject({
          code: "GIT_SYNC_SERVICE_FAILED",
          exitCode: 4,
          details: { phase: "wait-supervisor-lock", runningInstances: 0 },
        });

        expect(mutations).toEqual([]);
        expect(files.has(configuration.path)).toBe(true);
        expect(probeGitSyncSupervisorLock(fixture.home)).toBe("busy");
        expect(await probeGitSyncSupervisor(fixture.home, { version: "0.0.0" })).toMatchObject({
          responsive: true,
          instance: "foreign-foreground",
          pid: foreign.child.pid,
        });
        foreign.child.stdin.end();
        expect(await foreign.child.exited).toBe(0);
        expect(await foreign.errors).toBe("");
      } finally {
        await fixture.dispose();
      }
    },
    20_000,
  );
});
