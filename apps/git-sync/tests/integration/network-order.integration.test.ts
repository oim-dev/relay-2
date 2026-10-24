import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { KnowledgeService } from "@relay/core";
import { withGitFixture, waitForGitBarrier } from "./helpers/git-fixture";
import { DataRepository } from "../../src/transport/repository";
import { NetworkExchange } from "../../src/worker/network-exchange";
import { ownControl } from "../../src/local/control";
import { decodeSnapshot } from "../../src/snapshot/codec";
import type { ProcessResult } from "../../src/transport/process.types";

describe("Явный now не поглощается старым cycle", () => {
  test("now после задержанного refresh выполняет push своего durable ID", async () => {
    await withGitFixture(async (fixture) => {
      const seed = await fixture.replica("seed");
      await seed.engine.run();
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      /**
       * Останавливает только первый настоящий fetch, не заменяя Git ответ.
       */
      class PausedRefresh extends DataRepository {
        /* Барьер первой операции. */
        private pause = true;
        /**
         * Отмечает границу до подготовки/push и выпускает её явным событием теста.
         */
        override async fetch(): Promise<string | null> {
          const head = await super.fetch();
          if (this.pause) {
            this.pause = false;
            entered.resolve();
            await release.promise;
          }
          return head;
        }
      }
      const replica = await fixture.replica(
        "reader",
        seed,
        (options) => new PausedRefresh(options),
      );
      const document = await new KnowledgeService(replica.db).create(
        "document",
        { name: "Доставить", body: "после refresh" },
        "author",
      );
      const owner = await ownControl(
        join(replica.directory, "owner.json"),
        "request",
        replica.db.path,
        async () => null,
      );
      const exchange = new NetworkExchange(
        join(fixture.root, "standalone-home"),
        owner.endpoint,
        replica.engine,
        fixture.signal,
      );
      const reading = exchange.run(true);
      let writing: Promise<void> | undefined;
      try {
        await waitForGitBarrier(entered.promise, fixture.signal);
        writing = exchange.run();
        release.resolve();
        await Promise.all([reading, writing]);

        expect(replica.replication.status().pending).toBe(0);
        const head = await replica.repository.fetch();
        if (!head) {
          throw new Error("missing canonical head");
        }
        expect(
          decodeSnapshot(await replica.repository.files(head)).entities.find(
            (entry) => entry.record.id === document.id,
          )?.record.data.body,
        ).toBe("после refresh");
      } finally {
        release.resolve();
        await Promise.allSettled([reading, writing]);
        await owner.close();
      }
    });
  }, 20_000);

  test("поздний now во время push ждёт successor с новой локальной записью", async () => {
    await withGitFixture(async (fixture) => {
      const seed = await fixture.replica("seed-write");
      await seed.engine.run();
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      /**
       * Барьер после materialization, когда новые local writes уже не входят в отправляемый snapshot.
       */
      class PausedPush extends DataRepository {
        /* Блокируется только первая публикация. */
        private pause = true;
        /**
         * Даёт тесту принять второй now после фиксации первого кандидата.
         */
        override async push(commit: string): Promise<ProcessResult> {
          if (this.pause) {
            this.pause = false;
            entered.resolve();
            await release.promise;
          }
          return super.push(commit);
        }
      }
      const replica = await fixture.replica("writer", seed, (options) => new PausedPush(options));
      await new KnowledgeService(replica.db).create(
        "document",
        { name: "Первый", body: "первый" },
        "author",
      );
      const owner = await ownControl(
        join(replica.directory, "owner.json"),
        "request",
        replica.db.path,
        async () => null,
      );
      const exchange = new NetworkExchange(
        join(fixture.root, "standalone-home"),
        owner.endpoint,
        replica.engine,
        fixture.signal,
      );
      const first = exchange.run();
      let second: Promise<void> | undefined;
      try {
        await waitForGitBarrier(entered.promise, fixture.signal);
        const late = await new KnowledgeService(replica.db).create(
          "document",
          { name: "Поздний", body: "обязан войти во второй now" },
          "author",
        );
        second = exchange.run();
        release.resolve();
        await Promise.all([first, second]);

        expect(replica.replication.status().pending).toBe(0);
        const head = await replica.repository.fetch();
        if (!head) {
          throw new Error("missing canonical head");
        }
        expect(
          decodeSnapshot(await replica.repository.files(head)).entities.find(
            (entry) => entry.record.id === late.id,
          )?.record.data.body,
        ).toBe("обязан войти во второй now");
      } finally {
        release.resolve();
        await Promise.allSettled([first, second]);
        await owner.close();
      }
    });
  }, 20_000);
});
