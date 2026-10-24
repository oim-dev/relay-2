import { describe, expect, spyOn, test } from "bun:test";
import { cli, define } from "gunshi";
import { RelayError } from "@relay/contracts";
import { ProjectDatabase } from "@relay/storage";
import { CommandRegistry } from "../../src/execution/registry";
import { result } from "../../src/output/output";
import type { Result } from "../../src/output/output.types";
import { withCliFixture } from "./helpers/cli-fixture";

const group = "git-sync-implementation/cli-runtime/commands";

describe("Асинхронная граница предметного writer CLI", () => {
  test.each([false, true])(
    "соединение удерживается до settlement (отказ: %s), await не держит SQLite write lock",
    async (rejectWriter) => {
      await withCliFixture(async (fixture) => {
        const project = fixture.createProject();
        const reached = Promise.withResolvers<void>();
        const resume = Promise.withResolvers<void>();
        const failure = new RelayError("ASYNC_WRITER_REJECTED", "Отказ после async load", 4, {
          project: project.projectId,
        });
        const registry = new CommandRegistry(fixture.runtime);
        registry.add("fixture-write", {
          description: "Асинхронный writer",
          details: "Проверяет границу CLI без подмены SQLite.",
          examples: [{ description: "Выполнить", command: "relay fixture-write" }],
          mode: "create",
          args: { format: { type: "enum", choices: ["json"], default: "json" } },
          /**
           * Открывает настоящее соединение, приостанавливается на барьере и только затем возвращает исход.
           */
          run: async (invocation): Promise<Result> => {
            const database = invocation.db;
            reached.resolve();
            await resume.promise;
            if (rejectWriter) {
              throw failure;
            }
            return result(database.get(project.projectId));
          },
        });
        const close = spyOn(ProjectDatabase.prototype, "close");
        const pending = cli(["fixture-write"], define({ name: "relay" }), {
          subCommands: registry.commands,
        });
        // Обработчик отказа устанавливается до первого await, чтобы ранний сбой не стал unhandled rejection.
        const settled = pending.then(
          (text) => ({ ok: true as const, text }),
          (error: unknown) => ({ ok: false as const, error }),
        );
        try {
          const first = await Promise.race([
            reached.promise.then(() => "reached"),
            settled.then(() => "settled"),
          ]);
          expect(first).toBe("reached");
          expect(close).not.toHaveBeenCalled();
          const other = ProjectDatabase.open(project.databasePath);
          try {
            // Другая connection обязана получить настоящий BEGIN IMMEDIATE, пока writer ожидает I/O.
            other.transaction(() => {
              const initial = other.get(project.projectId);
              if (!initial) {
                throw new Error("Нет подготовленного проекта");
              }
              other.update(
                {
                  ...initial,
                  revision: initial.revision + 1,
                  data: { ...initial.data, name: "Параллельная запись" },
                },
                initial.revision,
              );
            });
          } finally {
            other.close();
          }

          resume.resolve();
          const outcome = await settled;

          expect(close).toHaveBeenCalledTimes(2);
          if (rejectWriter) {
            expect(outcome).toEqual({ ok: false, error: failure });
          } else {
            if (!outcome.ok) {
              throw outcome.error;
            }
            if (typeof outcome.text !== "string") {
              throw new Error("Асинхронный writer не вернул JSON-результат");
            }
            expect(JSON.parse(outcome.text)).toMatchObject({
              ok: true,
              data: { id: project.projectId, data: { name: "Параллельная запись" } },
            });
          }
        } finally {
          resume.resolve();
          await settled;
          close.mockRestore();
        }
      }, group);
    },
  );
});
