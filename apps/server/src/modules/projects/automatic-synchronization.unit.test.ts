import { describe, expect, test } from "bun:test";
import { AutomaticSynchronization } from "./automatic-synchronization";

describe("Владение фоновым обменом Server", () => {
  test("повторы объединяются, два проекта работают одновременно, queued не стартует после stop", async () => {
    const release = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    const calls: string[] = [];
    const warnings: unknown[] = [];
    const queue = new AutomaticSynchronization((error): void => {
      warnings.push(error);
    });
    /**
     * Отмечает настоящий старт операции; общий барьер оставляет оба слота занятыми.
     */
    const operation =
      (id: string): (() => Promise<void>) =>
      async (): Promise<void> => {
        calls.push(id);
        if (calls.length === 2) {
          entered.resolve();
        }
        await release.promise;
      };
    try {
      queue.request("a", operation("a"));
      queue.request("a", operation("duplicate"));
      queue.request("b", operation("b"));
      queue.request("c", operation("queued"));
      await entered.promise;
      queue.request("a", operation("duplicate-running"));
      queue.request("c", operation("duplicate-queued"));

      expect(calls).toEqual(["a", "b"]);
      const closing = queue.close();
      queue.request("d", operation("after-close"));
      release.resolve();
      await closing;
      expect(calls).toEqual(["a", "b"]);
      expect(warnings).toEqual([]);
    } finally {
      release.resolve();
      await queue.close();
    }
  });

  test("отказ освобождает слот и допускает новую попытку проекта, reporter получает исходную ошибку", async () => {
    const failure = new Error("Ошибка обмена");
    const completed = Promise.withResolvers<void>();
    const retried = Promise.withResolvers<void>();
    const warnings: unknown[] = [];
    const queue = new AutomaticSynchronization((error): void => {
      warnings.push(error);
    });
    const release = Promise.withResolvers<void>();
    const fail = Promise.withResolvers<void>();
    const calls: string[] = [];
    try {
      queue.request("a", async () => {
        await fail.promise;
        throw failure;
      });
      queue.request("b", async () => {
        await release.promise;
      });
      queue.request("c", async () => {
        calls.push("c");
        completed.resolve();
      });
      fail.resolve();
      await completed.promise;
      queue.request("a", async () => {
        calls.push("retry");
        retried.resolve();
      });
      await retried.promise;
      release.resolve();
      await queue.close();

      expect(warnings).toEqual([failure]);
      expect(calls).toEqual(["c", "retry"]);
    } finally {
      fail.resolve();
      release.resolve();
      await queue.close();
    }
  });

  test("ошибка reporter принадлежит close и не остаётся unhandled rejection", async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const reporterFailure = new Error("Диагностика недоступна");
    const queue = new AutomaticSynchronization(async () => {
      entered.resolve();
      await release.promise;
      throw reporterFailure;
    });
    queue.request("a", async () => {
      throw new Error("Обмен не удался");
    });
    await entered.promise;

    const closing = queue.close();
    release.resolve();
    expect(queue.close()).toBe(closing);
    await expect(closing).rejects.toMatchObject({ errors: [reporterFailure] });
  });
});
