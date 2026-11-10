import { describe, expect, spyOn, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { RelayError, type GitSyncRequest } from "@relay/contracts";
import { KnowledgeService } from "@relay/core";
import { openProject } from "@relay/project-runtime";
import { withServer, apiError } from "./fixture";
import { prepareDueSynchronization } from "./synchronization-fixture";

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
    return await knowledge.update(
      "document",
      initial.id,
      { body: "Пришедшая правка" },
      {
        actor: "remote",
        ifRevision: initial.revision,
      },
    );
  } finally {
    database.close();
  }
}

describe("Ленивый обмен перед HTTP/Core", () => {
  test("обычное REST-чтение видит завершившуюся запись auto в выбранный проект", async () => {
    const calls: GitSyncRequest[] = [];
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

        const response = await client.entity(location.projectId, initial.id);

        expect(response.data).toMatchObject({
          id: initial.id,
          revision: initial.revision + 1,
          data: { body: "Пришедшая правка" },
          updatedBy: "remote",
        });
        expect(calls).toEqual([
          { version: 1, action: "auto", options: { ...runtime, config: location.configPath } },
        ]);
      },
      {
        gitSync: {
          /**
           * Применяет пришедшую запись через отдельное соединение вместо Git-транспорта.
           */
          request: async (request) => {
            calls.push(request);
            return importDocument(request);
          },
        },
      },
    );
  });

  test.each(mutations)(
    "$name сохраняет исходный CAS после auto без потери пришедшей правки",
    async ({ batch }) => {
      const calls: GitSyncRequest[] = [];
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
        },
        {
          gitSync: {
            /**
             * Меняет локальную ревизию до Core, не меняя исходную HTTP-команду.
             */
            request: async (request) => {
              calls.push(request);
              return importDocument(request);
            },
          },
        },
      );
    },
  );

  test("отказ auto не отменяет HTTP mutation и первоначальную receipt, повторов доставки нет", async () => {
    const calls: GitSyncRequest[] = [];
    const warnings: unknown[] = [];
    await withServer(
      async ({ client, database, location }) => {
        prepareDueSynchronization(location);

        const response = await client.command(location.projectId, {
          op: "document.create",
          input: { name: "Локальный", body: "Не терять" },
          actor: "Web",
          operationKey: "offline-create",
        });

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
        expect(warnings).toEqual([{ code: "REMOTE_OFFLINE", message: "Нет сети" }]);
      },
      {
        /**
         * Наблюдает отдельную диагностику доставки вместе с успешной HTTP-квитанцией.
         */
        synchronizationWarning: (error): void => {
          warnings.push(error);
        },
        gitSync: {
          /**
           * Внедряет отказ только доставки, не подменяя предметный writer.
           */
          request: async (request) => {
            calls.push(request);
            throw new RelayError("REMOTE_OFFLINE", "Нет сети", 7);
          },
        },
      },
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
    );
  });
});
