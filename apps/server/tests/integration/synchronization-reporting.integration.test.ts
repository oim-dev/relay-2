import { describe, expect, test } from "bun:test";
import { RelayError } from "@relay/contracts";
import { withServer } from "./fixture";
import { prepareDueSynchronization } from "./synchronization-fixture";
import { deadline } from "../process/process-fixture";

describe("Ошибка фоновой диагностики при завершении Server", () => {
  test("отказ reporter виден в close, но listener всё равно освобождается", async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const failure = new Error("Канал диагностики недоступен");
    let projectId: string | undefined;
    let responseProjectId: string | undefined;
    let listening: boolean | undefined;
    let closeError: unknown;

    await expect(
      withServer(
        async ({ client, location, server }) => {
          projectId = location.projectId;
          prepareDueSynchronization(location);
          try {
            const response = await deadline(client.entity(location.projectId, "PROJECT"), 2000);
            responseProjectId = response.data.id;
            await deadline(entered.promise, 2000);

            const closing = server.close();
            release.resolve();
            closeError = await deadline(closing, 2000).then(
              () => null,
              (error: unknown) => error,
            );
            listening = server.app.getHttpServer().listening;
          } finally {
            release.resolve();
          }
        },
        {
          /**
           * Удерживает reporter после фонового отказа: HTTP не должен ждать даже этот канал.
           */
          synchronizationWarning: async (): Promise<void> => {
            entered.resolve();
            await release.promise;
            throw failure;
          },
          gitSync: {
            /**
             * Отдельный отказ доставки не заменяет успешный локальный HTTP-ответ.
             */
            request: async (): Promise<never> => {
              throw new RelayError("REMOTE_OFFLINE", "Нет сети", 7);
            },
          },
        },
        "background-sync-tests/fixtures",
      ),
    ).rejects.toMatchObject({ errors: [failure] });

    // Assertions выполняются после cleanup: ожидаемый повторный close не должен скрыть их отказ.
    expect(closeError).toMatchObject({ errors: [failure] });
    expect(projectId).toBeString();
    expect(responseProjectId).toBe(projectId);
    expect(listening).toBe(false);
  });
});
