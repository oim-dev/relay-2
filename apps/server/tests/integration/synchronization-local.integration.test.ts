import { describe, expect, test } from "bun:test";
import type { GitSyncRequest } from "@relay/contracts";
import { BatchService } from "@relay/core";
import { withServer, apiError } from "./fixture";
import { prepareDueSynchronization } from "./synchronization-fixture";

const diagnostics = [
  { name: "storage status", operation: "projectStatus", expected: { records: 3 } },
  {
    name: "doctor check",
    operation: "projectCheck",
    expected: { valid: true, records: 3, issues: [] },
  },
] as const;

describe("Локальные HTTP-наблюдения без автоматического обмена", () => {
  test.each(diagnostics)(
    "$name остаётся локальным при созревшем расписании",
    async ({ operation, expected }) => {
      const calls: GitSyncRequest[] = [];
      await withServer(
        async ({ client, location }) => {
          prepareDueSynchronization(location);

          const response = await client.read(location.projectId, operation, {});

          expect(response.data).toMatchObject(expected);
          expect(calls).toEqual([]);
        },
        {
          gitSync: {
            /**
             * Регистрирует даже успешный лишний auto, чтобы отказ порта не маскировал нарушение.
             */
            request: async (request) => {
              calls.push(request);
              return null;
            },
          },
        },
      );
    },
  );

  test("receipt возвращает первоначальный результат без auto", async () => {
    const calls: GitSyncRequest[] = [];
    await withServer(
      async ({ client, database, location }) => {
        const original = await database((db) =>
          new BatchService(db).execute(
            {
              version: 1,
              operations: [
                { op: "document.create", input: { name: "Квитанция", body: "Исходный текст" } },
              ],
            },
            { actor: "author", operationKey: "saved" },
          ),
        );
        prepareDueSynchronization(location);

        const response = await client.receipt(location.projectId, "saved");

        expect(response.data).toEqual({ ...original, replayed: true });
        expect(calls).toEqual([]);
      },
      {
        gitSync: {
          /**
           * Наблюдает лишний запуск обмена независимо от успешного чтения receipt.
           */
          request: async (request) => {
            calls.push(request);
            return null;
          },
        },
      },
    );
  });

  test("batch check не начинает auto и откатывает предметные и технические изменения", async () => {
    const calls: GitSyncRequest[] = [];
    await withServer(
      async ({ client, database, location }) => {
        prepareDueSynchronization(location);
        const schedule = await database((db) => db.getSynchronizationSchedule());

        const response = await client.batch(location.projectId, {
          commands: [{ op: "document.create", input: { name: "Проба", body: "Без записи" } }],
          actor: "Web",
          check: true,
          operationKey: "dry-run",
        });

        expect(response.data.status).toBe("checked");
        expect(await database((db) => db.list("document"))).toEqual([]);
        expect(await database((db) => db.getSynchronizationSchedule())).toEqual(schedule);
        await apiError(() => client.receipt(location.projectId, "dry-run"), "NOT_FOUND", 404);
        expect(calls).toEqual([]);
      },
      {
        gitSync: {
          /**
           * Наблюдает лишний auto до dry-run и не изменяет проверяемую БД.
           */
          request: async (request) => {
            calls.push(request);
            return null;
          },
        },
      },
    );
  });

  test("SSE connected и последующий poll читают generation без auto", async () => {
    const calls: GitSyncRequest[] = [];
    await withServer(
      async ({ server, location }) => {
        prepareDueSynchronization(location);

        const response = await fetch(`${server.url}api/v2/projects/${location.projectId}/events`, {
          signal: AbortSignal.timeout(3000),
        });
        const reader = response.body?.getReader();
        if (reader === undefined) {
          throw new Error("Нет SSE body");
        }
        let frames = "";
        try {
          // Heartbeat подтверждает настоящий poll после connected, а не ожидание произвольного sleep.
          while (!frames.includes("event: heartbeat\n")) {
            const chunk = await reader.read();
            if (chunk.done) {
              throw new Error("SSE завершился до heartbeat");
            }
            frames += new TextDecoder().decode(chunk.value);
          }

          expect(response.status).toBe(200);
          expect(frames).toContain("event: connected\n");
          expect(frames).toContain(`"projectId":"${location.projectId}"`);
          expect(calls).toEqual([]);
        } finally {
          await reader.cancel();
        }
      },
      {
        gitSync: {
          /**
           * Регистрирует скрытые обращения подключённого SSE и его фонового poll.
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
