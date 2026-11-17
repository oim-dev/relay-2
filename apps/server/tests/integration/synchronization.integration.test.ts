import { describe, expect, spyOn, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { RelayError, type GitSyncRequest } from "@relay/contracts";
import { KnowledgeService } from "@relay/core";
import { openProject } from "@relay/project-runtime";
import { withServer, apiError } from "./fixture";
import { prepareDueSynchronization } from "./synchronization-fixture";
import { deadline } from "../process/process-fixture";

const mutations = [
  { name: "одиночная command", batch: false },
  { name: "batch без check", batch: true },
] as const;

/**
 * Имитирует только импорт на процессной границе: Core пишет через второе реальное соединение.
 * Helper владеет соединением до settlement writer и не обновляет guards HTTP-команды.
 */
async function importDocument(request: GitSyncRequest): Promise<unknown> {
  const { database } = openProject(request.options);
  try {
    const knowledge = new KnowledgeService(database);
    const initial = knowledge.get("document", "DOC-1");
    await Promise.resolve();
    const updated = await knowledge.update(
      "document",
      initial.id,
      { body: "Пришедшая правка" },
      {
        actor: "remote",
        ifRevision: initial.revision,
      },
    );
    const at = Date.now();
    database.completeSynchronizationAttempt({ at, nextAttemptAt: at + 60_000, failed: false });
    return updated;
  } finally {
    database.close();
  }
}

describe("Фоновый обмен после локальной HTTP-операции", () => {
  test("чтения отвечают до завершения auto, объединяются в один обмен и затем видят импорт", async () => {
    const calls: GitSyncRequest[] = [];
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const completed = Promise.withResolvers<void>();
    await withServer(
      async ({ client, database, location, runtime }) => {
        const initial = await database((db) =>
          new KnowledgeService(db).create(
            "document",
            { name: "Правила", body: "До обмена" },
            "author",
          ),
        );
        prepareDueSynchronization(location);

        try {
          const response = await deadline(client.entity(location.projectId, initial.id), 2000);
          await deadline(entered.promise, 2000);
          const concurrent = await deadline(
            Promise.all(
              Array.from({ length: 6 }, () => client.entity(location.projectId, initial.id)),
            ),
            2000,
          );

          expect(response.data).toMatchObject({
            id: initial.id,
            revision: initial.revision,
            data: { body: "До обмена" },
          });
          expect(concurrent.every((entry) => entry.data.revision === initial.revision)).toBe(true);
          expect(calls).toEqual([
            { version: 1, action: "auto", options: { ...runtime, config: location.configPath } },
          ]);

          release.resolve();
          await deadline(completed.promise, 2000);
          const fresh = await client.entity(location.projectId, initial.id);
          expect(fresh.data).toMatchObject({
            id: initial.id,
            revision: initial.revision + 1,
            data: { body: "Пришедшая правка" },
            updatedBy: "remote",
          });
        } finally {
          release.resolve();
        }
      },
      {
        gitSync: {
          /**
           * Применяет пришедшую запись через отдельное соединение вместо Git-транспорта.
           */
          request: async (request) => {
            calls.push(request);
            entered.resolve();
            await release.promise;
            try {
              return await importDocument(request);
            } finally {
              completed.resolve();
            }
          },
        },
      },
      "background-sync-tests/fixtures",
    );
  });

  test.each(mutations)(
    "$name сохраняет исходный CAS после фонового импорта без подстановки свежей ревизии",
    async ({ batch }) => {
      const calls: GitSyncRequest[] = [];
      const completed = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      await withServer(
        async ({ client, database, location }) => {
          const initial = await database((db) =>
            new KnowledgeService(db).create(
              "document",
              { name: "Правила", body: "До обмена" },
              "author",
            ),
          );
          prepareDueSynchronization(location);
          const command = {
            op: "document.update" as const,
            ref: initial.id,
            ifRevision: initial.revision,
            input: { body: "Устаревший текст" },
          };
          const context = { actor: "Web", operationKey: "stale-after-auto" };

          try {
            await deadline(client.entity(location.projectId, initial.id), 2000);
            release.resolve();
            await deadline(completed.promise, 2000);
            await apiError(
              () =>
                batch
                  ? client.batch(location.projectId, { ...context, commands: [command] })
                  : client.command(location.projectId, { ...context, ...command }),
              "REVISION_CONFLICT",
              409,
            );

            expect(
              await database((db) => new KnowledgeService(db).get("document", initial.id)),
            ).toMatchObject({
              revision: initial.revision + 1,
              data: { body: "Пришедшая правка" },
              updatedBy: "remote",
            });
            await apiError(
              () => client.receipt(location.projectId, "stale-after-auto"),
              "NOT_FOUND",
              404,
            );
            expect(calls.map((request) => request.action)).toEqual(["auto"]);
          } finally {
            release.resolve();
          }
        },
        {
          gitSync: {
            /**
             * Меняет локальную ревизию до Core, не меняя исходную HTTP-команду.
             */
            request: async (request) => {
              calls.push(request);
              await release.promise;
              try {
                return await importDocument(request);
              } finally {
                completed.resolve();
              }
            },
          },
        },
        "background-sync-tests/fixtures",
      );
    },
  );

  test("отказ auto не отменяет HTTP mutation и первоначальную receipt, повторов доставки нет", async () => {
    const calls: GitSyncRequest[] = [];
    const warnings: unknown[] = [];
    const release = Promise.withResolvers<void>();
    const reported = Promise.withResolvers<void>();
    await withServer(
      async ({ client, database, location }) => {
        prepareDueSynchronization(location);

        try {
          const response = await deadline(
            client.command(location.projectId, {
              op: "document.create",
              input: { name: "Локальный", body: "Не терять" },
              actor: "Web",
              operationKey: "offline-create",
            }),
            2000,
          );

          expect(response.data.status).toBe("committed");
          const document = response.data.entities.find((entity) => entity.kind === "document");
          if (document === undefined) {
            throw new Error("HTTP mutation не вернула созданный документ");
          }
          expect(document.data).toMatchObject({ name: "Локальный", body: "Не терять" });
          expect(
            await database((db) => new KnowledgeService(db).get("document", document.id)),
          ).toEqual(document);
          expect((await client.receipt(location.projectId, "offline-create")).data).toEqual({
            ...response.data,
            replayed: true,
          });
          expect(calls.map((request) => request.action)).toEqual(["auto"]);
          expect(warnings).toEqual([]);
          release.resolve();
          await deadline(reported.promise, 2000);
          expect(warnings).toEqual([{ code: "REMOTE_OFFLINE", message: "Нет сети" }]);
          expect(
            await database((db) => new KnowledgeService(db).get("document", document.id)),
          ).toEqual(document);
          expect((await client.receipt(location.projectId, "offline-create")).data).toEqual({
            ...response.data,
            replayed: true,
          });
          expect(calls.map((request) => request.action)).toEqual(["auto"]);
        } finally {
          release.resolve();
        }
      },
      {
        /**
         * Наблюдает отдельную диагностику доставки вместе с успешной HTTP-квитанцией.
         */
        synchronizationWarning: (error): void => {
          warnings.push(error);
          reported.resolve();
        },
        gitSync: {
          /**
           * Внедряет отказ только доставки, не подменяя предметный writer.
           */
          request: async (request) => {
            calls.push(request);
            await release.promise;
            throw new RelayError("REMOTE_OFFLINE", "Нет сети", 7);
          },
        },
      },
      "background-sync-tests/fixtures",
    );
  });

  test("close ждёт фоновую попытку после уже отправленного HTTP-ответа", async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    await withServer(
      async ({ client, location, server }) => {
        prepareDueSynchronization(location);
        let closing: Promise<void> | undefined;
        let closed = false;
        try {
          await deadline(client.entity(location.projectId, "PROJECT"), 2000);
          await deadline(entered.promise, 2000);
          closing = server.close().then(() => {
            closed = true;
          });
          const rejected = await server.app.inject({
            method: "GET",
            url: "/api/v2/context",
            headers: { host: new URL(server.url).host },
          });

          expect(rejected.statusCode).toBe(503);
          expect(closed).toBe(false);
          release.resolve();
          await deadline(closing, 2000);
          expect(closed).toBe(true);
        } finally {
          release.resolve();
          await closing;
        }
      },
      {
        gitSync: {
          /**
           * Удерживает только фоновый процессный порт; HTTP не зависит от этого барьера.
           */
          request: async () => {
            entered.resolve();
            await release.promise;
            return null;
          },
        },
      },
      "background-sync-tests/fixtures",
    );
  });

  test("свежий debounce допускает REST-чтение без обращения к процессному порту", async () => {
    const calls: GitSyncRequest[] = [];
    await withServer(
      async ({ client, database, location, runtime }) => {
        mkdirSync(join(runtime.cwd, ".git"));
        const schedule = await database((db) => db.getSynchronizationSchedule());
        if (schedule.lastMutationAt === null) {
          throw new Error("Init должен оставить начальную публикацию в очереди");
        }
        const clock = spyOn(Date, "now").mockReturnValue(schedule.lastMutationAt);
        try {
          const response = await client.entity(location.projectId, "PROJECT");

          expect(response.data.id).toBe(location.projectId);
          expect(calls).toEqual([]);
          expect(await database((db) => db.getSynchronizationSchedule())).toEqual(schedule);
        } finally {
          clock.mockRestore();
        }
      },
      {
        gitSync: {
          /**
           * Фиксирует любое обращение, даже если CLI/Server поглотит результат порта.
           */
          request: async (request) => {
            calls.push(request);
            return null;
          },
        },
      },
      "background-sync-tests/fixtures",
    );
  });

  test("manual не начинает auto при созревшем расписании и сохраняет локальный ответ", async () => {
    const calls: GitSyncRequest[] = [];
    await withServer(
      async ({ client, database, location }) => {
        prepareDueSynchronization(location);
        await database((db) => db.setSynchronizationMode("manual"));
        const schedule = await database((db) => db.getSynchronizationSchedule());

        const response = await client.entity(location.projectId, "PROJECT");

        expect(response.data.id).toBe(location.projectId);
        expect(calls).toEqual([]);
        expect(await database((db) => db.getSynchronizationSchedule())).toEqual(schedule);
      },
      {
        gitSync: {
          /**
           * Успешный лишний вызов не должен скрыться за локальным HTTP-ответом.
           */
          request: async (request) => {
            calls.push(request);
            return null;
          },
        },
      },
      "background-sync-tests/fixtures",
    );
  });

  test("предметный отказ не запускает созревший auto и не сохраняет receipt", async () => {
    const calls: GitSyncRequest[] = [];
    await withServer(
      async ({ client, database, location }) => {
        prepareDueSynchronization(location);
        const generation = await database((db) => db.getGeneration());

        await apiError(
          () =>
            client.command(location.projectId, {
              op: "document.update",
              ref: "DOC-404",
              ifRevision: 1,
              input: { body: "Не записан" },
              actor: "Web",
              operationKey: "failed-before-auto",
            }),
          "NOT_FOUND",
          404,
        );

        expect(calls).toEqual([]);
        expect(await database((db) => db.getGeneration())).toBe(generation);
        await apiError(
          () => client.receipt(location.projectId, "failed-before-auto"),
          "NOT_FOUND",
          404,
        );
      },
      {
        gitSync: {
          /**
           * Наблюдает нарушение порядка: постановка в очередь разрешена только после успеха Core.
           */
          request: async (request) => {
            calls.push(request);
            return null;
          },
        },
      },
      "background-sync-tests/fixtures",
    );
  });
});
