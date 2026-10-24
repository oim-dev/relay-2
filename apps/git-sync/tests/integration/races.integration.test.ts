import { describe, expect, test } from "bun:test";
import { KnowledgeService } from "@relay/core";
import { waitForGitBarrier, withGitFixture } from "./helpers/git-fixture";
import { DataRepository } from "../../src/transport/repository";
import type { ProcessResult } from "../../src/transport/process.types";
import { git, requireGit } from "../../src/transport/git";

describe("Конкурирующие публикации immutable changeset", () => {
  test("два writer на одном head сходятся после non-FF без потери и повторения операций", async () => {
    await withGitFixture(async (fixture) => {
      const seed = await fixture.replica("seed");
      await seed.engine.run();
      const gate = Promise.withResolvers<void>();
      let arrivals = 0;
      /**
       * Удерживает первые два настоящих push на одном remote parent без временных предположений.
       */
      class BarrierRepository extends DataRepository {
        /* Только первый push каждого участника участвует в барьере. */
        private first = true;
        /**
         * Разрешает race после готовности обоих кандидатов; дальнейшие retry идут обычным Git.
         */
        override async push(commit: string): Promise<ProcessResult> {
          if (this.first) {
            this.first = false;
            arrivals++;
            if (arrivals === 2) {
              gate.resolve();
            }
            await waitForGitBarrier(gate.promise, fixture.signal);
          }
          return super.push(commit);
        }
      }
      const left = await fixture.replica("left", seed, (options) => new BarrierRepository(options));
      const right = await fixture.replica(
        "right",
        seed,
        (options) => new BarrierRepository(options),
      );
      const a = await new KnowledgeService(left.db).create("feature", { name: "Левая" }, "left");
      const b = await new KnowledgeService(right.db).create("feature", { name: "Правая" }, "right");

      const results = await Promise.allSettled([left.engine.run(), right.engine.run()]);
      for (const result of results) {
        if (result.status === "rejected") {
          throw result.reason;
        }
      }
      await left.engine.run();
      await right.engine.run();

      expect(left.db.get(a.id)?.data.name).toBe("Левая");
      expect(left.db.get(b.id)?.data.name).toBe("Правая");
      expect(right.db.get(a.id)?.data.name).toBe("Левая");
      expect(right.db.get(b.id)?.data.name).toBe("Правая");
      expect(left.db.get(a.id)?.key).not.toBe(left.db.get(b.id)?.key);
      expect(left.replication.core.status().pending).toBe(0);
      expect(right.replication.core.status().pending).toBe(0);
      expect(
        requireGit(
          await git(fixture.remote, ["rev-list", "--count", "refs/heads/relay-data-v2"]),
          "count",
        ),
      ).toBe("3");
    });
  }, 15_000);

  test("локальная запись во время медленного fetch не ждёт сеть и входит в последующую публикацию", async () => {
    await withGitFixture(async (fixture) => {
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      /**
       * Останавливает сеть после реального fetch, до подготовки предметного снимка.
       */
      class PausedFetch extends DataRepository {
        /**
         * Сигнализирует точную фазу тесту и ждёт завершения независимой SQL-записи.
         */
        override async fetch(): Promise<string | null> {
          const head = await super.fetch();
          entered.resolve();
          await waitForGitBarrier(release.promise, fixture.signal);
          return head;
        }
      }
      const replica = await fixture.replica(
        "local",
        undefined,
        (options) => new PausedFetch(options),
      );
      const exchange = replica.engine.run();
      void exchange.catch((error: unknown) => entered.reject(error));
      try {
        await waitForGitBarrier(entered.promise, fixture.signal);
        const document = await new KnowledgeService(replica.db).create(
          "document",
          { name: "Во время сети", body: "готово" },
          "local",
        );

        release.resolve();
        await exchange;

        expect(replica.db.get(document.id)?.data.body).toBe("готово");
        expect(replica.replication.core.status().pending).toBe(0);
      } finally {
        release.resolve();
        await replica.engine.settled();
      }
    });
  });
});
