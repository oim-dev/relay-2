import { describe, expect, test } from "bun:test";
import { renameSync } from "node:fs";
import { KnowledgeService, ProjectDatabase } from "@relay/core";
import { SyncEngine } from "../../src/sync/engine";
import { ReplicationAdapter } from "../../src/sync/replication-adapter";
import { DataRepository } from "../../src/transport/repository";
import type { ProcessResult } from "../../src/transport/process.types";
import { decodeSnapshot } from "../../src/snapshot/codec";
import { readProgress } from "../../src/local/state";
import { GIT_FIXTURE_DRAIN_MS, withGitFixture } from "./helpers/git-fixture";
import { gitFixtureDeadlines } from "./helpers/git-fixture-budgets";

const artifacts = "git-sync-implementation/finalization/windows-git-fixtures/fixtures";
const budget = { maxChangesets: 2, maxBytes: 1024 * 1024 };
const deadlineMs = gitFixtureDeadlines.boundedRecovery;

describe("Cursor bounded окна при transport retry", () => {
  test(
    "non-FF и неизвестный исход повторяют исходный cursor; новый owner подтверждает только реальные sources",
    async () => {
      await withGitFixture(
        async (fixture) => {
          fixture.phase("prepare/accepted-baseline");
          const competitor = await fixture.replica("competitor");
          await competitor.engine.run();
          let beforePush: (() => Promise<void>) | undefined;
          let loseReply = false;
          const candidates: string[][] = [];
          const cursors: number[] = [];
          let progressDirectory = "";
          /**
           * Перед первым push продвигает настоящий remote; второй push принимается с потерянным ответом.
           */
          class RacingRepository extends DataRepository {
            /**
             * Фиксирует source IDs и durable cursor до сети; SQL-мутации не повторяются.
             */
            override async push(commit: string): Promise<ProcessResult> {
              if (progressDirectory) {
                candidates.push(
                  decodeSnapshot(await this.files(commit)).publication?.changes.map(
                    (entry) => entry.source.id,
                  ) ?? [],
                );
                cursors.push(readProgress(progressDirectory).afterSequence);
              }
              if (beforePush) {
                const competingWrite = beforePush;
                beforePush = undefined;
                await competingWrite();
              }
              const result = await super.push(commit);
              if (loseReply && result.exitCode === 0) {
                loseReply = false;
                renameSync(fixture.remote, fixture.remote + "-offline");
                return {
                  exitCode: 128,
                  stdout: Buffer.alloc(0),
                  stderr: Buffer.from("lost successful response"),
                };
              }
              return result;
            }
          }
          const local = await fixture.replica(
            "retry",
            competitor,
            (options) => new RacingRepository(options),
          );
          fixture.phase("prepare/initial-window-and-tail");
          const knowledge = new KnowledgeService(local.db);
          for (let index = 0; index < 3; index++) {
            await knowledge.create(
              "document",
              { name: `Начало ${index}`, body: `Текст ${index}` },
              "local",
            );
          }
          const initial = local.db.getReplicationOutbox();
          const second = initial[1];
          if (!second) {
            throw new Error("Нет первого полного окна");
          }
          const engine = new SyncEngine(
            local.directory,
            local.db.projectId,
            local.replication,
            local.repository,
            fixture.signal,
            budget,
          );
          await engine.run();
          expect(readProgress(local.directory).afterSequence).toBe(second.sequence);
          for (let index = 0; index < 2; index++) {
            await knowledge.create(
              "document",
              { name: `Продолжение ${index}`, body: "Хвост" },
              "local",
            );
          }
          const pending = local.db.getReplicationOutbox();
          progressDirectory = local.directory;
          loseReply = true;
          /**
           * Детерминированно меняет parent после materialization локального кандидата, до его push.
           */
          beforePush = async (): Promise<void> => {
            fixture.phase("barrier/competing-publication-before-push");
            await new KnowledgeService(competitor.db).create(
              "feature",
              { name: "Конкурент" },
              "remote",
            );
            await competitor.engine.run();
            fixture.phase("act/non-ff-and-lost-reply");
          };

          fixture.phase("act/non-ff-and-lost-reply");
          await expect(engine.run()).rejects.toMatchObject({
            code: "GIT_PUSH_OUTCOME_UNKNOWN",
            exitCode: 4,
          });

          fixture.phase("assert/unknown-outcome-and-original-cursor");
          expect(candidates).toEqual([
            pending.slice(0, 2).map((source) => source.id),
            pending.slice(0, 2).map((source) => source.id),
          ]);
          expect(cursors).toEqual([second.sequence, second.sequence]);
          expect(readProgress(local.directory)).toMatchObject({
            afterSequence: second.sequence,
            publicationWindow: {
              afterSequence: second.sequence,
              included: pending.slice(0, 2).map((source) => source.id),
              completed: false,
            },
            error: { code: "GIT_PUSH_OUTCOME_UNKNOWN" },
          });
          expect(local.db.getReplicationOutbox()).toEqual(pending);
          const replicaId = local.replication.status().replicaId;
          local.db.close();
          renameSync(fixture.remote + "-offline", fixture.remote);
          const database = ProjectDatabase.open(local.db.path);
          try {
            fixture.phase("prepare/reopened-owner");
            const adapter = new ReplicationAdapter(database);
            const repository = new DataRepository(local.repository.options);
            await repository.initialize();
            const recovered = new SyncEngine(
              local.directory,
              database.projectId,
              adapter,
              repository,
              fixture.signal,
              budget,
            );
            expect(recovered.progress.afterSequence).toBe(second.sequence);

            fixture.phase("act/recovery");
            await recovered.run();

            fixture.phase("assert/exact-proofs-and-tail");
            expect(database.getReplicationOutbox()).toEqual([]);
            expect(adapter.status()).toMatchObject({ replicaId, pending: 0 });
            expect(readProgress(local.directory).afterSequence).toBe(0);
            const head = await repository.fetch();
            if (!head) {
              throw new Error("Нет принятого head");
            }
            const snapshot = decodeSnapshot(await repository.files(head));
            const own = snapshot.confirmations.find(
              (entry) => entry.replicaId === replicaId,
            )?.proofs;
            expect(own?.map(({ sequence, digest }) => ({ sequence, digest }))).toEqual(
              [...initial.slice(0, 2), ...pending].map(({ sequence, digest }) => ({
                sequence,
                digest,
              })),
            );
            expect(
              snapshot.entities.filter((entry) => entry.record.kind === "document"),
            ).toHaveLength(5);
            expect(snapshot.publication?.changes.map((entry) => entry.source)).toEqual(
              pending.slice(2),
            );
          } finally {
            database.close();
          }
        },
        artifacts,
        { name: "bounded-retry", deadlineMs },
      );
    },
    deadlineMs + GIT_FIXTURE_DRAIN_MS,
  );
});
