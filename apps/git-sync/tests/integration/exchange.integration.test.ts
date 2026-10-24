import { describe, expect, test } from "bun:test";
import { renameSync } from "node:fs";
import { KnowledgeService, ProjectDatabase } from "@relay/core";
import { withGitFixture } from "./helpers/git-fixture";
import { DataRepository } from "../../src/transport/repository";
import { git, requireGit } from "../../src/transport/git";
import { decodeSnapshot } from "../../src/snapshot/codec";
import { ReplicationAdapter } from "../../src/sync/replication-adapter";
import type { ProcessResult } from "../../src/transport/process.types";
import { readProgress } from "../../src/local/state";
import { SyncEngine } from "../../src/sync/engine";
import { syncStatus } from "../../src/worker/status";

/**
 * Доставляет настоящий push, затем теряет единственный ответ: Core не должен повторять mutation.
 */
class LostReplyRepository extends DataRepository {
  /* Сбой инъецируется один раз, чтобы тест проверял recovery, а не бесконечную сеть. */
  private lose = true;

  /**
   * Оставляет реально принятую общую ветку, возвращая транспортный отказ вместо успешного ответа.
   */
  override async push(commit: string): Promise<ProcessResult> {
    const result = await super.push(commit);
    if (result.exitCode === 0 && this.lose) {
      this.lose = false;
      return { exitCode: 128, stdout: Buffer.alloc(0), stderr: Buffer.from("lost reply") };
    }
    return result;
  }
}

describe("Обмен одной общей Git-ветки", () => {
  test("непроверенный исход push остаётся явной ошибкой и восстанавливается после повторного открытия", async () => {
    await withGitFixture(async (fixture) => {
      /**
       * Принимает push, но делает remote недоступным до проверки исхода.
       */
      class UnknownOutcome extends DataRepository {
        /**
         * Оставляет canonical commit, теряя ответ и последующий доступ к origin.
         */
        override async push(commit: string): Promise<ProcessResult> {
          const result = await super.push(commit);
          if (result.exitCode === 0) {
            renameSync(fixture.remote, fixture.remote + "-unavailable");
            return { exitCode: 128, stdout: Buffer.alloc(0), stderr: Buffer.from("reply lost") };
          }
          return result;
        }
      }
      const replica = await fixture.replica(
        "unknown",
        undefined,
        (options) => new UnknownOutcome(options),
      );
      const document = await new KnowledgeService(replica.db).create(
        "document",
        { name: "Однократно", body: "не повторять" },
        "author",
      );

      await expect(replica.engine.run()).rejects.toMatchObject({
        code: "GIT_PUSH_OUTCOME_UNKNOWN",
      });

      expect(replica.replication.status().pending).toBeGreaterThan(0);
      replica.db.close();
      renameSync(fixture.remote + "-unavailable", fixture.remote);
      const database = ProjectDatabase.open(replica.db.path);
      try {
        const adapter = new ReplicationAdapter(database);
        const repository = new DataRepository(replica.repository.options);
        await repository.initialize();
        await new SyncEngine(
          replica.directory,
          database.projectId,
          adapter,
          repository,
          new AbortController().signal,
        ).run();
        expect(adapter.status().pending).toBe(0);
        expect(database.get(document.id)?.data.body).toBe("не повторять");
        expect(
          requireGit(
            await git(fixture.remote, ["rev-list", "--count", "refs/heads/relay-data-v2"]),
            "count",
          ),
        ).toBe("1");
      } finally {
        database.close();
      }
    });
  }, 15_000);

  test("три pending changeset в одном неподтверждённом Git-кандидате дают ahead=1", async () => {
    await withGitFixture(async (fixture) => {
      let reject = false;
      /**
       * Моделирует отказ публикации после первого успешного bootstrap общей ветки.
       */
      class RejectedPush extends DataRepository {
        /**
         * Отказывает без изменения remote; повторный fetch подтверждает, что кандидат не принят.
         */
        override push(commit: string): Promise<ProcessResult> {
          return reject
            ? Promise.resolve({
                exitCode: 128,
                stdout: Buffer.alloc(0),
                stderr: Buffer.from("offline push"),
              })
            : super.push(commit);
        }
      }
      const replica = await fixture.replica(
        "counts",
        undefined,
        (options) => new RejectedPush(options),
      );
      await replica.engine.run();
      for (let index = 0; index < 3; index++) {
        await new KnowledgeService(replica.db).create(
          "document",
          { name: `Пакет ${index}`, body: "pending" },
          "author",
        );
      }
      reject = true;

      await expect(replica.engine.run()).rejects.toMatchObject({ code: "GIT_FAILED" });

      expect(replica.replication.core.status().pending).toBe(3);
      expect(readProgress(replica.directory).git).toMatchObject({ ahead: 1, behind: 0 });
      expect(await replica.repository.counts()).toMatchObject({ ahead: 1, behind: 0 });
    });
  }, 15_000);

  test("потерянный push-ответ подтверждает только отправленные ID и сохраняет позднюю локальную запись pending", async () => {
    await withGitFixture(async (fixture) => {
      const seed = await fixture.replica("seed-late");
      await seed.engine.run();
      let lateWrite: (() => Promise<void>) | undefined;
      /**
       * Создаёт локальную транзакцию строго после remote acceptance, но до получения ответа.
       */
      class LateWriteRepository extends DataRepository {
        /**
         * Теряет один ответ уже принятого push, сохраняя конкурентную durable-запись на прежнем base.
         */
        override async push(commit: string): Promise<ProcessResult> {
          const result = await super.push(commit);
          if (result.exitCode === 0 && lateWrite) {
            const mutation = lateWrite;
            lateWrite = undefined;
            await mutation();
            return {
              exitCode: 128,
              stdout: Buffer.alloc(0),
              stderr: Buffer.from("lost response after acceptance"),
            };
          }
          return result;
        }
      }
      const replica = await fixture.replica(
        "late",
        seed,
        (options) => new LateWriteRepository(options),
      );
      const knowledge = new KnowledgeService(replica.db);
      const sent = await knowledge.create(
        "document",
        { name: "Отправлен", body: "ранний" },
        "author",
      );
      let laterId = "";
      /**
       * Дожидается commit поздней записи до возврата потерянного ответа сети.
       */
      lateWrite = async (): Promise<void> => {
        const later = await knowledge.create(
          "document",
          { name: "Поздний", body: "сохранить pending" },
          "author",
        );
        laterId = later.id;
      };

      await replica.engine.run();

      expect(replica.replication.core.status().pending).toBe(1);
      expect(replica.db.get(sent.id)?.data.body).toBe("ранний");
      expect(replica.db.get(laterId)?.data.body).toBe("сохранить pending");
      await replica.engine.run();
      expect(replica.replication.core.status().pending).toBe(0);
      const head = await replica.repository.fetch();
      if (!head) {
        throw new Error("missing head");
      }
      const remote = decodeSnapshot(await replica.repository.files(head));
      expect(remote.entities.find((item) => item.record.id === laterId)?.record.data.body).toBe(
        "сохранить pending",
      );
      expect(
        requireGit(
          await git(fixture.remote, ["rev-list", "--count", "refs/heads/relay-data-v2"]),
          "count",
        ),
      ).toBe("3");
    });
  }, 15_000);

  test("A → B → A без изменений не создаёт echo-коммиты, outbox и новые revisions", async () => {
    await withGitFixture(async (fixture) => {
      const first = await fixture.replica("a");
      const doc = await new KnowledgeService(first.db).create(
        "document",
        { name: "Exact", body: "# Текст\r\n\tстрока  \r\n" },
        "author",
      );
      requireGit(
        await git(first.repository.options.directory, ["config", "core.autocrlf", "true"]),
        "autocrlf",
      );
      await first.engine.run();
      const head = await first.repository.ref("refs/heads/data");
      expect(head).not.toBeNull();
      const second = await fixture.replica("b", first);
      const before = second.db.get(doc.id);

      await second.engine.run();
      await first.engine.run();

      expect(await first.repository.ref("refs/heads/data")).toBe(head);
      expect(await second.repository.ref("refs/heads/data")).toBe(head);
      expect(second.db.get(doc.id)).toEqual(before);
      expect(second.db.get(doc.id)?.data.body).toBe("# Текст\r\n\tстрока  \r\n");
      expect(first.replication.core.status().pending).toBe(0);
      expect(second.replication.core.status().pending).toBe(0);
      expect(await second.repository.counts()).toMatchObject({ ahead: 0, behind: 0 });
      const refs = requireGit(
        await git(fixture.remote, ["for-each-ref", "--format=%(refname)"]),
        "remote-refs",
      );
      expect(refs).toBe("refs/heads/relay-data-v2");
    });
  });

  test("потерянный ответ push подтверждается принятой историей без повторной пользовательской записи", async () => {
    await withGitFixture(async (fixture) => {
      const replica = await fixture.replica(
        "lost",
        undefined,
        (options) => new LostReplyRepository(options),
      );
      const document = await new KnowledgeService(replica.db).create(
        "document",
        { name: "Сохранён", body: "один раз" },
        "author",
      );
      const generation = replica.db.getGeneration();

      await replica.engine.run();
      await replica.engine.run();

      expect(replica.replication.core.status().pending).toBe(0);
      expect(replica.db.getGeneration()).toBe(generation);
      expect(replica.db.get(document.id)?.revision).toBe(document.revision);
      expect(
        requireGit(
          await git(fixture.remote, ["rev-list", "--count", "refs/heads/relay-data-v2"]),
          "count",
        ),
      ).toBe("1");
    });
  });

  test("сетевая ошибка не становится отсутствующей веткой и сохраняет durable pending после закрытия БД", async () => {
    await withGitFixture(async (fixture) => {
      const replica = await fixture.replica("offline");
      await replica.engine.run();
      const doc = await new KnowledgeService(replica.db).create(
        "document",
        { name: "Offline", body: "не теряется" },
        "author",
      );
      renameSync(fixture.remote, fixture.remote + "-offline");

      await expect(replica.engine.run()).rejects.toMatchObject({ code: "GIT_FAILED" });
      const pending = replica.replication.core.status().pending;
      replica.db.close();
      const reopened = ProjectDatabase.open(replica.db.path);
      try {
        expect(new ReplicationAdapter(reopened).core.status().pending).toBe(pending);
        expect(pending).toBeGreaterThan(0);
        expect(reopened.get(doc.id)?.data.body).toBe("не теряется");
      } finally {
        reopened.close();
      }
    });
  });

  test("refresh получает behind, но не применяет remote и не отправляет pending", async () => {
    await withGitFixture(async (fixture) => {
      const first = await fixture.replica("writer");
      await first.engine.run();
      const second = await fixture.replica("reader", first);
      await second.engine.run();
      const local = await new KnowledgeService(second.db).create(
        "document",
        { name: "Локальный", body: "pending" },
        "second",
      );
      const remote = await new KnowledgeService(first.db).create(
        "feature",
        { name: "Удалённый" },
        "first",
      );
      await first.engine.run();
      const pending = second.replication.core.status().pending;

      await second.engine.run(true);

      expect(second.db.get(remote.id)).toBeUndefined();
      expect(second.db.get(local.id)?.data.body).toBe("pending");
      expect(second.replication.core.status().pending).toBe(pending);
      expect(await second.repository.counts()).toMatchObject({ ahead: 0, behind: 1 });
      const diagnostic = await syncStatus(
        second.directory,
        null,
        second.replication.status(),
        second.engine.progress,
      );
      expect(diagnostic.conflicts).toMatchObject({
        freshness: "stale",
        remoteHead: second.engine.progress.conflictsHead,
      });
      const head = await second.repository.fetch();
      if (!head) {
        throw new Error("missing expected remote");
      }
      expect(
        decodeSnapshot(await second.repository.files(head)).entities.some(
          (entry) => entry.record.id === local.id,
        ),
      ).toBe(false);
    });
  });
});
