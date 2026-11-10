import { describe, expect, spyOn, test } from "bun:test";
import * as files from "node:fs";
import { join } from "node:path";
import { RelayError } from "@relay/contracts";
import {
  buildSourceGuardianComponent,
  GuardedCommandError,
  initializeProject,
} from "@relay/project-runtime";
import { executeGitSyncRequest } from "../../src/index";
import { runProcess } from "../../src/transport/process";
import { withGitProcessRuntime } from "../../src/transport/process-runtime";
import * as processRuntime from "../../src/transport/process-runtime";
import { containsFailure, withRuntimeDirectory } from "./helpers/source-runtime-fixture";

const callbackOutcomes = [
  { name: "успешного callback", callbackFailed: false },
  { name: "отказавшего callback", callbackFailed: true },
] as const;

describe("Отказы cleanup и observer source runtime", () => {
  test.each(callbackOutcomes)(
    "cleanup failure после $name отклоняет scope без потери исходных причин",
    async ({ callbackFailed }) => {
      await withRuntimeDirectory(async (root) => {
        const directory = join(root, "helper");
        const primary = new RelayError("PRIMARY_OPERATION", "Исходный отказ операции", 4, {
          retained: true,
        });
        const cleanup = Object.assign(new Error("Собственный helper заблокирован"), {
          code: "EACCES",
        });
        const diagnostic = new Error("Вторичный отказ observer");
        const actualRemove = files.rmSync;
        const removal = spyOn(files, "rmSync").mockImplementation((path, options) => {
          if (path === directory) {
            throw cleanup;
          }
          actualRemove(path, options);
        });
        try {
          const failure: unknown = await withGitProcessRuntime(
            async () => {
              const result = await runProcess({
                executable: process.execPath,
                args: ["-e", 'process.stdout.write("target завершён")'],
                cwd: root,
                timeoutMs: 5000,
              });
              expect(result.exitCode).toBe(0);
              expect(result.stdout.toString()).toBe("target завершён");
              if (callbackFailed) {
                throw primary;
              }
              return "success";
            },
            directory,
            callbackFailed
              ? () => {
                  throw diagnostic;
                }
              : undefined,
          ).catch((error: unknown) => error);

          expect(files.existsSync(directory)).toBe(true);
          expect(containsFailure(failure, cleanup)).toBe(true);
          if (callbackFailed) {
            expect(failure).toMatchObject({
              code: primary.code,
              exitCode: 4,
              details: primary.details,
            });
            expect(containsFailure(failure, primary)).toBe(true);
            expect(containsFailure(failure, diagnostic)).toBe(true);
          } else {
            expect(failure).toMatchObject({
              code: "GIT_CLEANUP_FAILED",
              exitCode: 1,
              details: { operation: "source-helper-cleanup", path: directory },
            });
            expect(failure instanceof Error && failure.cause).toBe(cleanup);
          }
        } finally {
          removal.mockRestore();
        }
      });
    },
    15_000,
  );

  test("cleanup неудачной сборки source helper сохраняется вместо поздней отмены обращения", async () => {
    await withRuntimeDirectory(async (root) => {
      const options = { cwd: root, home: join(root, "runtime-home") };
      initializeProject({ ...options, name: "Failed helper build cleanup" });
      const directory = join(root, "helper");
      const caller = new AbortController();
      const primary = new Error("Отказ компилятора helper");
      const cleanup = Object.assign(new Error("Незавершённый helper не удалён"), {
        code: "EACCES",
      });
      const originalScope = processRuntime.withGitProcessRuntime;
      let scopeFailure: unknown;
      const scope = spyOn(processRuntime, "withGitProcessRuntime").mockImplementation((operation) =>
        originalScope(operation, directory).catch((error: unknown) => {
          scopeFailure = error;
          throw error;
        }),
      );
      const build = spyOn(Bun, "build").mockImplementation(async () => {
        // Сборка отклонена до установки ownedDirectory; cleanup выполняет настоящий builder Runtime.
        caller.abort("SIGTERM");
        throw primary;
      });
      const actualRemove = files.rmSync;
      const removal = spyOn(files, "rmSync").mockImplementation((path, options) => {
        if (path === directory) {
          throw cleanup;
        }
        actualRemove(path, options);
      });
      try {
        const failure: unknown = await executeGitSyncRequest(
          { version: 1, action: "connect", options, input: { remote: join(root, "remote.git") } },
          {
            env: {
              ...process.env,
              HOME: join(root, "home"),
              USERPROFILE: join(root, "home"),
              RELAY_HOME: options.home,
            },
            signal: caller.signal,
          },
        ).catch((error: unknown) => error);

        expect(caller.signal.aborted).toBe(true);
        expect(files.existsSync(directory)).toBe(true);
        expect(failure).toMatchObject({
          code: "GIT_GUARDIAN_FAILED",
          exitCode: 1,
          details: { reason: "guardian" },
        });
        expect(containsFailure(failure, primary)).toBe(true);
        expect(containsFailure(failure, cleanup)).toBe(true);
        expect(failure).toBe(scopeFailure);
      } finally {
        removal.mockRestore();
        build.mockRestore();
        scope.mockRestore();
      }
    });
  });

  test.each([false, true])(
    "build failure сохраняется при cleanup failure: %s",
    async (cleanupFailed) => {
      await withRuntimeDirectory(async (root) => {
        const directory = join(root, "helper");
        const primary = new Error("Исходный compiler failure");
        const cleanup = Object.assign(new Error("Output не удаляется"), { code: "EACCES" });
        const build = spyOn(Bun, "build").mockImplementation(async () => {
          throw primary;
        });
        const actualRemove = files.rmSync;
        const removal = spyOn(files, "rmSync").mockImplementation((path, options) => {
          if (cleanupFailed && path === directory) {
            throw cleanup;
          }
          actualRemove(path, options);
        });
        try {
          const failure: unknown = await buildSourceGuardianComponent(directory).catch(
            (error: unknown) => error,
          );
          expect(containsFailure(failure, primary)).toBe(true);
          expect(files.existsSync(directory)).toBe(cleanupFailed);
          if (cleanupFailed) {
            expect(failure).toMatchObject({ errors: [primary, cleanup] });
          } else {
            expect(failure).toBe(primary);
          }
        } finally {
          removal.mockRestore();
          build.mockRestore();
        }
      });
    },
  );

  test("observer не заменяет успешные bytes/exit; scope сообщает первую причину и число сбоев", async () => {
    await withRuntimeDirectory(async (root) => {
      const directory = join(root, "helper");
      const first = new Error("Первая ошибка диагностики");
      const second = new Error("Следующая ошибка диагностики");
      let observations = 0;
      const failure: unknown = await withGitProcessRuntime(
        async () => {
          for (let index = 0; index < 2; index++) {
            const result = await runProcess({
              executable: process.execPath,
              args: ["-e", "process.stdout.write(Buffer.from([0,255,128,10]));process.exitCode=23"],
              cwd: root,
              timeoutMs: 5000,
              maxBytes: 4,
            });
            expect(result.exitCode).toBe(23);
            expect(result.stdout).toEqual(Buffer.from([0, 255, 128, 10]));
            expect(result.stderr.length).toBe(0);
          }
        },
        directory,
        (observation) => {
          expect(Object.keys(observation)).not.toContain("stdout");
          expect(Object.keys(observation)).not.toContain("stderr");
          expect(Object.keys(observation)).not.toContain("input");
          expect(Object.keys(observation)).not.toContain("env");
          throw ++observations === 1 ? first : second;
        },
      ).catch((error: unknown) => error);

      expect(failure).toMatchObject({
        code: "GIT_OBSERVER_FAILED",
        exitCode: 1,
        details: { failures: 2 },
        cause: first,
      });
      expect(containsFailure(failure, second)).toBe(false);
      expect(files.existsSync(directory)).toBe(false);
    });
  }, 15_000);

  test("spawn failure и native cause остаются primary при сбое observer", async () => {
    await withRuntimeDirectory(async (root) => {
      const directory = join(root, "helper");
      const diagnostic = new Error("Observer отказал");
      let commandFailure: unknown;
      const failure: unknown = await withGitProcessRuntime(
        async () => {
          try {
            await runProcess({
              executable: join(root, "missing-target"),
              args: [],
              cwd: root,
              timeoutMs: 5000,
            });
          } catch (error) {
            commandFailure = error;
            throw error;
          }
        },
        directory,
        () => {
          throw diagnostic;
        },
      ).catch((error: unknown) => error);

      expect(commandFailure).toBeInstanceOf(RelayError);
      expect(commandFailure).toMatchObject({ code: "GIT_START_FAILED", exitCode: 1 });
      if (!(
        commandFailure instanceof Error && commandFailure.cause instanceof GuardedCommandError
      )) {
        throw new Error("Нет native причины spawn failure");
      }
      expect(commandFailure.cause.reason).toBe("spawn");
      expect(commandFailure.cause.stage).toBe("command-spawn");
      expect(commandFailure.cause.systemCode).toBeDefined();
      expect(failure).toMatchObject({ code: "GIT_START_FAILED", exitCode: 1 });
      expect(containsFailure(failure, commandFailure)).toBe(true);
      expect(containsFailure(failure, diagnostic)).toBe(true);
      expect(files.existsSync(directory)).toBe(false);
    });
  }, 15_000);
});
