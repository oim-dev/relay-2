import { describe, expect, test } from "bun:test";
import { KnowledgeService } from "@relay/core";
import { waitForGitBarrier, withGitFixture } from "./helpers/git-fixture";
import { DataRepository } from "../../src/transport/repository";
import { git, requireGit } from "../../src/transport/git";
import { TeamRepository, TwoWriterBarrier } from "./team-helpers/publication-barrier";

describe("Конкурирующие публикации immutable changeset", () => {
  test("два writer на одном head сходятся после non-FF и явного выбора ключа без повторения операций", async () => {
    await withGitFixture(async (fixture) => {
      const seed = await fixture.replica("seed");
      await seed.engine.run();
      const left = await fixture.replica("left", seed, (options) => new TeamRepository(options));
      const right = await fixture.replica("right", seed, (options) => new TeamRepository(options));
      if (
        !(left.repository instanceof TeamRepository) ||
        !(right.repository instanceof TeamRepository)
      ) {
        throw new Error("Гонка требует наблюдаемый Git-транспорт обоих участников");
      }
      const a = await new KnowledgeService(left.db).create("feature", { name: "Левая" }, "left");
      const b = await new KnowledgeService(right.db).create("feature", { name: "Правая" }, "right");
      const original = right.db.getReplicationOutbox();
      expect(a.key).toBe(b.key);

      const barrier = new TwoWriterBarrier(fixture.signal);
      left.repository.gateNextPush(barrier, "first");
      right.repository.gateNextPush(barrier, "second");
      try {
        const results = await Promise.allSettled(
          [left.engine.run(), right.engine.run()].map((attempt) =>
            attempt.catch((error: unknown) => {
              barrier.close();
              throw error;
            }),
          ),
        );
        for (const result of results) {
          if (result.status === "rejected") {
            throw result.reason;
          }
        }
      } finally {
        barrier.close();
      }
      expect(left.repository.publications).toHaveLength(1);
      expect(right.repository.publications).toHaveLength(1);
      expect(left.repository.publications[0]?.exitCode).toBe(0);
      expect(right.repository.publications[0]?.exitCode).not.toBe(0);
      expect(right.repository.publications[0]?.stdout).toMatch(
        /\[rejected\].*(fetch first|non-fast-forward)/,
      );
      expect(right.repository.publications[0]?.parent).toBe(
        left.repository.publications[0]?.parent,
      );
      expect(right.db.getReplicationOutbox()).toEqual(original);
      expect(right.db.get(b.id)?.key).toBe(b.key);
      expect(left.replication.keyConflicts()).toEqual([]);
      const conflicts = right.replication.keyConflicts();
      expect(conflicts).toHaveLength(1);
      const conflict = conflicts[0];
      if (conflict === undefined) {
        throw new Error("Проигравшее назначение должно ожидать явного выбора ключа");
      }
      expect(conflict.code).toBe("REPLICATION_KEY_COLLISION");
      expect(conflict.collisions).toHaveLength(1);
      expect(conflict.collisions[0]).toMatchObject({
        entityId: b.id,
        key: b.key,
        acceptedOwnerId: a.id,
      });
      const assignments = conflict.collisions.map((entry) => ({
        entityId: entry.entityId,
        key: entry.suggestedKey,
      }));
      const preview = right.replication.resolveKeys(
        conflict.id,
        { fingerprint: conflict.fingerprint, assignments },
        "key-resolver",
      );
      expect(preview.included).toEqual(original.map((change) => change.id));
      expect(preview.conflicts).toEqual([]);
      expect(right.db.getReplicationOutbox()).toEqual(original);

      await right.engine.run();
      await left.engine.run();

      expect(left.db.get(a.id)?.data.name).toBe("Левая");
      expect(left.db.get(b.id)?.data.name).toBe("Правая");
      expect(right.db.get(a.id)?.data.name).toBe("Левая");
      expect(right.db.get(b.id)?.data.name).toBe("Правая");
      expect(left.db.get(a.id)?.key).toBe(a.key);
      expect(right.db.get(a.id)?.key).toBe(a.key);
      expect(left.db.get(b.id)?.key).toBe(assignments[0]?.key);
      expect(right.db.get(b.id)?.key).toBe(assignments[0]?.key);
      expect(left.db.get(b.id)?.key).not.toBe(a.key);
      expect(right.repository.publications).toHaveLength(2);
      expect(right.repository.publications[1]?.exitCode).toBe(0);
      expect(right.repository.publications[1]?.parent).toBe(
        left.repository.publications[0]?.commit,
      );
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
