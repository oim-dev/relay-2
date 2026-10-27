import { describe, expect, test } from "bun:test";
import { AsyncLocalStorage } from "node:async_hooks";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { nativeExecutableName } from "@relay/project-runtime";
import { runProcess } from "../../src/transport/process";
import type { ProcessResult } from "../../src/transport/process.types";
import { withGitProcessRuntime } from "../../src/transport/process-runtime";
import { withRuntimeDirectory } from "./helpers/source-runtime-fixture";

describe("Владение fresh source Git helper", () => {
  test.each([false, true])(
    "scope ждёт начатую команду до удаления helper; ошибка caller: %s",
    async (failed) => {
      await withRuntimeDirectory(async (root) => {
        const directory = join(root, "helper");
        const expected = new Error("Исходная ошибка caller");
        const observations: string[][] = [];
        let pending: Promise<ProcessResult> | undefined;
        let late: (() => Promise<ProcessResult>) | undefined;
        const operation = withGitProcessRuntime(
          async () => {
            expect(existsSync(directory)).toBe(false);
            // Callback намеренно завершается раньше target: scope обязан дождаться своего pending.
            pending = runProcess({
              executable: process.execPath,
              args: ["-e", 'process.stdout.write("Сохранённый результат")'],
              cwd: root,
              timeoutMs: 5000,
            });
            late = AsyncLocalStorage.bind(() =>
              runProcess({
                executable: process.execPath,
                args: ["-e", 'throw new Error("Поздний target не должен запуститься")'],
                cwd: root,
                timeoutMs: 5000,
              }),
            );
            if (failed) {
              throw expected;
            }
          },
          directory,
          (observation) => {
            expect(existsSync(directory)).toBe(true);
            observations.push([...observation.component]);
          },
        );
        if (failed) {
          await expect(operation).rejects.toBe(expected);
        } else {
          await operation;
        }

        if (pending === undefined) {
          throw new Error("Target не запущен");
        }
        const result = await pending;
        expect(result.exitCode).toBe(0);
        expect(result.stdout.toString()).toBe("Сохранённый результат");
        expect(observations).toHaveLength(1);
        expect(observations[0]).toEqual([join(directory, nativeExecutableName("guardian"))]);
        expect(existsSync(directory)).toBe(false);
        if (late === undefined) {
          throw new Error("Не сохранён async context владельца");
        }
        await expect(late()).rejects.toMatchObject({ code: "GIT_CANCELLED" });
      });
    },
    15_000,
  );

  test("занятый каталог не принимается за свежий helper и сохраняет чужие файлы", async () => {
    await withRuntimeDirectory(async (root) => {
      const directory = join(root, "occupied");
      mkdirSync(directory);
      const marker = join(directory, "keep.txt");
      writeFileSync(marker, "Не заменять");

      await expect(
        withGitProcessRuntime(async () => {
          await runProcess({
            executable: process.execPath,
            args: ["-e", 'throw new Error("Target не должен начаться")'],
            cwd: root,
          });
        }, directory),
      ).rejects.toMatchObject({ code: "EEXIST" });
      expect(readFileSync(marker, "utf8")).toBe("Не заменять");
    });
  });

  test("сценарий без внешних процессов не собирает helper и не создаёт его каталог", async () => {
    await withRuntimeDirectory(async (root) => {
      const directory = join(root, "unused");
      expect(await withGitProcessRuntime(async () => "cached-status", directory)).toBe(
        "cached-status",
      );
      expect(existsSync(directory)).toBe(false);
    });
  });
});
