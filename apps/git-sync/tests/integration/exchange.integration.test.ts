import { describe, expect, test } from "bun:test";
import { renameSync } from "node:fs";
import { KnowledgeService, ProjectDatabase } from "@relay/core";
import { GIT_FIXTURE_DRAIN_MS, withGitFixture } from "./helpers/git-fixture";
import { DataRepository } from "../../src/transport/repository";
import { git, requireGit } from "../../src/transport/git";
import { decodeSnapshot } from "../../src/snapshot/codec";
import { ReplicationAdapter } from "../../src/sync/replication-adapter";
import type { ProcessResult } from "../../src/transport/process.types";
import { readProgress } from "../../src/local/state";
import { SyncEngine } from "../../src/sync/engine";
import { syncStatus } from "../../src/worker/status";

const artifacts = "git-sync-implementation/finalization/windows-git-fixtures/fixtures";
const recoveryDeadlineMs = 15_000;
const exchangeDeadlineMs = 5_000;

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
  test(
    "непроверенный исход push остаётся явной ошибкой и восстанавливается после повторного открытия",
    async () => {
      await withGitFixture(
        async (fixture) => {
          fixture.phase("prepare/unknown-push");
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
                return {
                  exitCode: 128,
                  stdout: Buffer.alloc(0),
                  stderr: Buffer.from("reply lost"),
                };
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

          fixture.phase("act/unknown-push");
          await expect(replica.engine.run()).rejects.toMatchObject({
            code: "GIT_PUSH_OUTCOME_UNKNOWN",
          });

          fixture.phase("assert/durable-pending-and-reopen");
          expect(replica.replication.status().pending).toBeGreaterThan(0);
          replica.db.close();
          renameSync(fixture.remote + "-unavailable", fixture.remote);
          const database = ProjectDatabase.open(replica.db.path);
          try {
            const adapter = new ReplicationAdapter(database);
            const repository = new DataRepository(replica.repository.options);
            await repository.initialize();
            fixture.phase("act/reopened-recovery");
            await new SyncEngine(
              replica.directory,
              database.projectId,
              adapter,
              repository,
              fixture.signal,
            ).run();
            fixture.phase("assert/recovered-once");
            expect(adapter.status().pending).toBe(0);
            expect(database.get(document.id)?.data.body).toBe("не повторять");
            expect(
              requireGit(
                await git(
                  fixture.remote,
                  ["rev-list", "--count", "refs/heads/relay-data-v2"],
                  replica.repository.options,
                ),
                "count",
              ),
            ).toBe("1");
          } finally {
            database.close();
          }
        },
        artifacts,
        { name: "exchange-unknown", deadlineMs: recoveryDeadlineMs },
      );
    },
    recoveryDeadlineMs + GIT_FIXTURE_DRAIN_MS,
  );

  test(
    "три pending changeset в одном неподтверждённом Git-кандидате дают ahead=1",
    async () => {
      await withGitFixture(
        async (fixture) => {
          fixture.phase("prepare/rejected-push-and-three-sources");
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

          fixture.phase("act/rejected-push");
          await expect(replica.engine.run()).rejects.toMatchObject({ code: "GIT_FAILED" });

          fixture.phase("assert/ahead-versus-pending");
          expect(replica.replication.core.status().pending).toBe(3);
          expect(readProgress(replica.directory).git).toMatchObject({ ahead: 1, behind: 0 });
          expect(await replica.repository.counts()).toMatchObject({ ahead: 1, behind: 0 });
        },
        artifacts,
        { name: "exchange-ahead", deadlineMs: recoveryDeadlineMs },
      );
    },
    recoveryDeadlineMs + GIT_FIXTURE_DRAIN_MS,
  );

  test(
    "потерянный push-ответ подтверждает только отправленные ID и сохраняет позднюю локальную запись pending",
    async () => {
      await withGitFixture(
        async (fixture) => {
          fixture.phase("prepare/late-write-baseline");
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
            fixture.phase("barrier/late-write-after-remote-acceptance");
            const later = await knowledge.create(
              "document",
              { name: "Поздний", body: "сохранить pending" },
              "author",
            );
            laterId = later.id;
            fixture.phase("act/recover-lost-reply");
          };

          fixture.phase("act/recover-lost-reply");
          await replica.engine.run();

          fixture.phase("assert/late-write-is-pending");
          expect(replica.replication.core.status().pending).toBe(1);
          expect(replica.db.get(sent.id)?.data.body).toBe("ранний");
          expect(replica.db.get(laterId)?.data.body).toBe("сохранить pending");
          fixture.phase("act/deliver-late-write");
          await replica.engine.run();
          fixture.phase("assert/late-publication");
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
              await git(
                fixture.remote,
                ["rev-list", "--count", "refs/heads/relay-data-v2"],
                replica.repository.options,
              ),
              "count",
            ),
          ).toBe("3");
        },
        artifacts,
        { name: "exchange-late", deadlineMs: recoveryDeadlineMs },
      );
    },
    recoveryDeadlineMs + GIT_FIXTURE_DRAIN_MS,
  );

  test(
    "A → B → A без изменений не создаёт echo-коммиты, outbox и новые revisions",
    async () => {
      await withGitFixture(
        async (fixture) => {
          fixture.phase("prepare/no-echo-baseline");
          const first = await fixture.replica("a");
          const doc = await new KnowledgeService(first.db).create(
            "document",
            { name: "Exact", body: "# Текст\r\n\tстрока  \r\n" },
            "author",
          );
          requireGit(
            await git(
              first.repository.options.directory,
              ["config", "core.autocrlf", "true"],
              first.repository.options,
            ),
            "autocrlf",
          );
          await first.engine.run();
          const head = await first.repository.ref("refs/heads/data");
          expect(head).not.toBeNull();
          const second = await fixture.replica("b", first);
          const before = second.db.get(doc.id);

          fixture.phase("act/a-b-a-without-changes");
          await second.engine.run();
          await first.engine.run();

          fixture.phase("assert/no-echo");
          expect(await first.repository.ref("refs/heads/data")).toBe(head);
          expect(await second.repository.ref("refs/heads/data")).toBe(head);
          expect(second.db.get(doc.id)).toEqual(before);
          expect(second.db.get(doc.id)?.data.body).toBe("# Текст\r\n\tстрока  \r\n");
          expect(first.replication.core.status().pending).toBe(0);
          expect(second.replication.core.status().pending).toBe(0);
          expect(await second.repository.counts()).toMatchObject({ ahead: 0, behind: 0 });
          const refs = requireGit(
            await git(
              fixture.remote,
              ["for-each-ref", "--format=%(refname)"],
              first.repository.options,
            ),
            "remote-refs",
          );
          expect(refs).toBe("refs/heads/relay-data-v2");
        },
        artifacts,
        { name: "exchange-no-echo", deadlineMs: exchangeDeadlineMs },
      );
    },
    exchangeDeadlineMs + GIT_FIXTURE_DRAIN_MS,
  );

  test(
    "потерянный ответ push подтверждается принятой историей без повторной пользовательской записи",
    async () => {
      await withGitFixture(
        async (fixture) => {
          fixture.phase("prepare/lost-reply");
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

          fixture.phase("act/lost-reply-and-idle");
          await replica.engine.run();
          await replica.engine.run();

          fixture.phase("assert/exactly-once");
          expect(replica.replication.core.status().pending).toBe(0);
          expect(replica.db.getGeneration()).toBe(generation);
          expect(replica.db.get(document.id)?.revision).toBe(document.revision);
          expect(
            requireGit(
              await git(
                fixture.remote,
                ["rev-list", "--count", "refs/heads/relay-data-v2"],
                replica.repository.options,
              ),
              "count",
            ),
          ).toBe("1");
        },
        artifacts,
        { name: "exchange-lost-reply", deadlineMs: exchangeDeadlineMs },
      );
    },
    exchangeDeadlineMs + GIT_FIXTURE_DRAIN_MS,
  );

  test(
    "сетевая ошибка не становится отсутствующей веткой и сохраняет durable pending после закрытия БД",
    async () => {
      await withGitFixture(
        async (fixture) => {
          fixture.phase("prepare/offline-pending");
          const replica = await fixture.replica("offline");
          await replica.engine.run();
          const doc = await new KnowledgeService(replica.db).create(
            "document",
            { name: "Offline", body: "не теряется" },
            "author",
          );
          renameSync(fixture.remote, fixture.remote + "-offline");

          fixture.phase("act/offline-fetch");
          await expect(replica.engine.run()).rejects.toMatchObject({ code: "GIT_FAILED" });
          fixture.phase("assert/pending-after-reopen");
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
        },
        artifacts,
        { name: "exchange-offline", deadlineMs: exchangeDeadlineMs },
      );
    },
    exchangeDeadlineMs + GIT_FIXTURE_DRAIN_MS,
  );

  test(
    "refresh получает behind, но не применяет remote и не отправляет pending",
    async () => {
      await withGitFixture(
        async (fixture) => {
          fixture.phase("prepare/refresh-baseline");
          const first = await fixture.replica("writer");
          await first.engine.run();
          const second = await fixture.replica("reader", first);
          await second.engine.run();
          fixture.phase("prepare/local-pending-and-remote-advance");
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

          fixture.phase("act/refresh-only");
          await second.engine.run(true);

          fixture.phase("assert/no-import-no-push");
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
        },
        artifacts,
        { name: "exchange-refresh", deadlineMs: exchangeDeadlineMs },
      );
    },
    exchangeDeadlineMs + GIT_FIXTURE_DRAIN_MS,
  );
});
