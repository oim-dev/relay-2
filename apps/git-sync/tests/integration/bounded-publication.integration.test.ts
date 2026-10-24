import { describe, expect, spyOn, test } from "bun:test";
import { join } from "node:path";
import { KnowledgeService, ProjectDatabase } from "@relay/core";
import { SyncEngine } from "../../src/sync/engine";
import { ReplicationAdapter } from "../../src/sync/replication-adapter";
import { readProgress } from "../../src/local/state";
import { syncStatus } from "../../src/worker/status";
import { getConflict, listConflicts, resolveConflictRequest } from "../../src/app/conflicts";
import { decodeSnapshot } from "../../src/snapshot/codec";
import { GIT_FIXTURE_DRAIN_MS, withGitFixture } from "./helpers/git-fixture";
import { gitFixtureDeadlines } from "./helpers/git-fixture-budgets";
import type { ReplicaFixture } from "./helpers/git-fixture.types";
import { ownControl } from "../../src/local/control";
import { ControlOperations } from "../../src/local/operations";
import { NetworkExchange } from "../../src/worker/network-exchange";
import { submitNetworkOperation } from "../../src/app/network-operations";
import { writeLocalJson } from "../../src/local/files";

const artifacts = "git-sync-implementation/finalization/windows-git-fixtures/fixtures";
const budget = { maxChangesets: 2, maxBytes: 1024 * 1024 };
const restartDeadlineMs = gitFixtureDeadlines.boundedRecovery;
const windowDeadlineMs = gitFixtureDeadlines.exchange;

/**
 * Подключает production engine с малым Core budget; состояние и соединение принадлежат fixture.
 */
function boundedEngine(
  replica: ReplicaFixture,
  signal: AbortSignal,
  replication = replica.replication,
): SyncEngine {
  return new SyncEngine(
    replica.directory,
    replica.db.projectId,
    replication,
    replica.repository,
    signal,
    budget,
  );
}

describe("Durable обход bounded Git-публикаций", () => {
  test(
    "restart проходит два пустых конфликтных окна и доставляет независимый хвост, сохраняя blocked overlay",
    async () => {
      await withGitFixture(
        async (fixture) => {
          fixture.phase("prepare/shared-baseline");
          const remote = await fixture.replica("remote");
          const remoteKnowledge = new KnowledgeService(remote.db);
          const shared = [];
          for (let index = 0; index < 4; index++) {
            shared.push(
              await remoteKnowledge.create(
                "document",
                { name: `Общий ${index}`, body: "Основа" },
                "seed",
              ),
            );
          }
          await remote.engine.run();
          fixture.phase("prepare/divergent-changes-and-tail");
          const local = await fixture.replica("local", remote);
          const knowledge = new KnowledgeService(local.db);
          for (const document of shared) {
            const localBefore = knowledge.get("document", document.id);
            const remoteBefore = remoteKnowledge.get("document", document.id);
            await knowledge.update(
              "document",
              document.id,
              { body: "Локальная сторона" },
              { actor: "local", ifRevision: localBefore.revision },
            );
            await remoteKnowledge.update(
              "document",
              document.id,
              { body: "Удалённая сторона" },
              { actor: "remote", ifRevision: remoteBefore.revision },
            );
          }
          const first = shared[0];
          if (!first) {
            throw new Error("Нет исходного документа");
          }
          const changed = knowledge.get("document", first.id);
          await knowledge.update(
            "document",
            first.id,
            { summary: "Зависимый overlay" },
            { actor: "local", ifRevision: changed.revision },
          );
          const tail = [];
          for (let index = 0; index < 2; index++) {
            tail.push(
              await knowledge.create(
                "document",
                { name: `Хвост ${index}`, body: `Доставка ${index}` },
                "local",
              ),
            );
          }
          const sources = local.db.getReplicationOutbox();
          const conflicting = sources.slice(0, 4);
          const [blocked, ready, last] = sources.slice(4);
          if (
            !blocked ||
            !ready ||
            !last ||
            !conflicting[0] ||
            !conflicting[1] ||
            !conflicting[3]
          ) {
            throw new Error("Нет семи исходных changeset");
          }
          expect(blocked.dependencies).toEqual([conflicting[0].id]);
          fixture.phase("prepare/publish-remote-side");
          await remote.engine.run();
          const remoteHead = await remote.repository.fetch();
          const engine = boundedEngine(local, fixture.signal);
          const scan = spyOn(local.replication.core, "blocked");

          fixture.phase("act/first-conflicting-window");
          await engine.run();

          fixture.phase("assert/first-window-and-reopen");
          expect(scan).not.toHaveBeenCalled();
          scan.mockRestore();
          expect(readProgress(local.directory)).toMatchObject({
            publicationReplicaId: local.replication.status().replicaId,
            publicationDatabaseIdentity: local.replication.databaseIdentity,
            afterSequence: conflicting[1].sequence,
            publicationWindow: {
              examined: conflicting.slice(0, 2).map((source) => source.id),
              included: [],
              deferred: [],
              hasMore: true,
              completed: true,
            },
          });
          expect(await local.repository.fetch()).toBe(remoteHead);
          expect(local.db.getReplicationOutbox()).toEqual(sources);
          expect(
            await syncStatus(local.directory, null, local.replication.status(), engine.progress),
          ).toMatchObject({ conflicts: { count: 4, freshness: "partial" } });
          local.db.close();
          const reopened = ProjectDatabase.open(local.db.path);
          try {
            const replication = new ReplicationAdapter(reopened);
            const restarted = boundedEngine(local, fixture.signal, replication);
            fixture.phase("act/restarted-second-conflicting-window");
            await restarted.run();
            fixture.phase("assert/restarted-second-window");
            expect(readProgress(local.directory)).toMatchObject({
              afterSequence: conflicting[3].sequence,
              publicationWindow: {
                afterSequence: conflicting[1].sequence,
                examined: conflicting.slice(2).map((source) => source.id),
                included: [],
                hasMore: true,
                completed: true,
              },
            });
            expect(await local.repository.fetch()).toBe(remoteHead);

            const hotScan = spyOn(replication.core, "blocked");
            fixture.phase("act/blocked-and-first-tail-window");
            await restarted.run();
            fixture.phase("assert/pending-after-first-tail");
            const status = await syncStatus(
              local.directory,
              null,
              replication.status(),
              restarted.progress,
            );
            expect(hotScan).not.toHaveBeenCalled();
            hotScan.mockRestore();
            expect(status).toMatchObject({
              pending: { changesets: 6, unexported: 6 },
              publication: {
                afterSequence: ready.sequence,
                window: {
                  examined: [blocked.id, ready.id],
                  included: [ready.id],
                  deferred: [blocked.id],
                  hasMore: true,
                  completed: true,
                },
              },
            });
            expect(reopened.getReplicationOutbox()).toEqual([...conflicting, blocked, last]);

            const successor = boundedEngine(local, fixture.signal, replication);
            fixture.phase("act/last-tail-window");
            await successor.run();
            fixture.phase("assert/tail-publication-and-conflict-guards");
            expect(readProgress(local.directory)).toMatchObject({
              afterSequence: 0,
              publicationWindow: { included: [last.id], hasMore: false, completed: true },
            });
            expect(reopened.getReplicationOutbox()).toEqual([...conflicting, blocked]);
            expect(reopened.get(first.id)?.data).toMatchObject({
              body: "Локальная сторона",
              summary: "Зависимый overlay",
            });
            const acceptedHead = await local.repository.fetch();
            if (!acceptedHead) {
              throw new Error("Нет опубликованного хвоста");
            }
            const snapshot = decodeSnapshot(await local.repository.files(acceptedHead));
            for (const document of shared) {
              expect(
                snapshot.entities.find((entry) => entry.record.id === document.id)?.record.data
                  .body,
              ).toBe("Удалённая сторона");
            }
            for (const [index, document] of tail.entries()) {
              expect(
                snapshot.entities.find((entry) => entry.record.id === document.id)?.record.data
                  .body,
              ).toBe(`Доставка ${index}`);
            }
            expect(
              snapshot.confirmations
                .find((entry) => entry.replicaId === ready.replicaId)
                ?.proofs?.map((proof) => proof.sequence),
            ).toEqual([ready.sequence, last.sequence]);

            const diagnostics = listConflicts(replication);
            expect(diagnostics.conflicts.map((entry) => entry.id).sort()).toEqual(
              conflicting.map((source) => source.id).sort(),
            );
            expect(diagnostics.blocked).toEqual([
              {
                id: blocked.id,
                state: "pending",
                code: "REPLICATION_DEPENDENCY",
                message: "Изменение ожидает принятия причинной зависимости",
                dependencies: [conflicting[0].id],
              },
            ]);
            const waiting = diagnostics.blocked[0];
            if (!waiting) {
              throw new Error("Нет причины ожидания зависимого source");
            }
            expect(getConflict(replication, blocked.id)).toEqual(waiting);
            const guard = reopened.getReplicationGuard();
            const before = replication.capture();
            expect(() =>
              resolveConflictRequest(replication, {
                id: blocked.id,
                actor: "resolver",
                decision: { choice: "local", fingerprint: "invented" },
              }),
            ).toThrow(
              expect.objectContaining({
                code: "REPLICATION_DEPENDENCY",
                exitCode: 4,
                details: { blocked: diagnostics.blocked[0] },
              }),
            );
            expect(reopened.getReplicationGuard()).toEqual(guard);
            expect(replication.capture()).toEqual(before);
            expect(reopened.getReplicationOutbox()).toEqual([...conflicting, blocked]);

            fixture.phase("act/no-echo-conflicting-window");
            await successor.run();
            fixture.phase("assert/no-echo-and-explicit-resolution");
            expect(await local.repository.fetch()).toBe(acceptedHead);
            const conflict = getConflict(replication, conflicting[0].id);
            if (!("fingerprint" in conflict)) {
              throw new Error("Ожидались стороны действительного конфликта");
            }
            const resolution = resolveConflictRequest(replication, {
              id: conflict.id,
              actor: "resolver",
              decision: { choice: "local", fingerprint: conflict.fingerprint },
            });
            expect(resolution).toMatchObject({
              id: conflict.id,
              included: [conflict.id, blocked.id],
              pending: 5,
              deferred: [],
              hasMore: false,
              blocked: diagnostics.blocked,
            });
            expect(resolution.conflicts.map((entry) => entry.id).sort()).toEqual(
              conflicting
                .slice(1)
                .map((source) => source.id)
                .sort(),
            );
          } finally {
            reopened.close();
          }
        },
        artifacts,
        { name: "bounded-restart", deadlineMs: restartDeadlineMs },
      );
    },
    restartDeadlineMs + GIT_FIXTURE_DRAIN_MS,
  );

  test(
    "одно успешное окно оставляет точный pending без конфликтов и не заявляет доставку остатка",
    async () => {
      await withGitFixture(
        async (fixture) => {
          fixture.phase("prepare/window-and-legacy-progress");
          const replica = await fixture.replica("window");
          await replica.engine.run();
          for (let index = 0; index < 3; index++) {
            await new KnowledgeService(replica.db).create(
              "document",
              { name: `Пакет ${index}`, body: "Сохранить" },
              "author",
            );
          }
          const sources = replica.db.getReplicationOutbox();
          const {
            publicationReplicaId: _replica,
            publicationDatabaseIdentity: _database,
            afterSequence: _cursor,
            publicationWindow: _window,
            ...legacy
          } = replica.engine.progress;
          writeLocalJson(join(replica.directory, "progress.json"), legacy);
          expect(readProgress(replica.directory).afterSequence).toBe(0);
          const engine = boundedEngine(replica, fixture.signal);
          const owner = await ownControl(
            join(replica.directory, "worker.json"),
            "request",
            replica.db.path,
            async () => null,
          );
          const operations = new ControlOperations(replica.directory, owner.endpoint.instance);
          const exchange = new NetworkExchange(
            join(fixture.root, "standalone"),
            owner.endpoint,
            engine,
            fixture.signal,
          );
          try {
            fixture.phase("act/one-now-window");
            submitNetworkOperation(
              operations,
              exchange,
              replica.replication,
              "single-window",
              "now",
              () =>
                syncStatus(replica.directory, null, replica.replication.status(), engine.progress),
            );
            await operations.settled();
            fixture.phase("assert/one-now-window");
            const outcome = operations.get("single-window");
            expect(outcome.state).toBe("completed");
            if (outcome.state !== "completed") {
              throw new Error("Pending из-за budget ошибочно объявлен неуспешным now");
            }
            expect(outcome.result).toMatchObject({
              pending: { changesets: 1, unexported: 1 },
              conflicts: { count: 0 },
              error: null,
              publication: {
                window: {
                  examined: sources.slice(0, 2).map((source) => source.id),
                  included: sources.slice(0, 2).map((source) => source.id),
                  deferred: [],
                  hasMore: true,
                  completed: true,
                },
              },
            });
            expect(replica.db.getReplicationOutbox()).toEqual(sources.slice(2));
            fixture.phase("act/remaining-window");
            await boundedEngine(replica, fixture.signal).run();
            fixture.phase("assert/empty-pending");
            expect(replica.replication.status().pending).toBe(0);
            expect(readProgress(replica.directory).afterSequence).toBe(0);
          } finally {
            operations.closeAcceptance();
            await exchange.settled();
            await owner.close();
          }
        },
        artifacts,
        { name: "bounded-window", deadlineMs: windowDeadlineMs },
      );
    },
    windowDeadlineMs + GIT_FIXTURE_DRAIN_MS,
  );

  test(
    "cursor чужой replicaId либо физической БД не пропускает очередь нового владельца",
    async () => {
      await withGitFixture(
        async (fixture) => {
          fixture.phase("prepare/foreign-scope");
          const replica = await fixture.replica("scope");
          const current = replica.engine.progress;
          const pending = replica.db.getReplicationOutbox();
          fixture.phase("act-and-assert/foreign-cursors");
          for (const scope of [
            {
              publicationReplicaId: "foreign-replica",
              publicationDatabaseIdentity: replica.replication.databaseIdentity,
            },
            {
              publicationReplicaId: replica.replication.status().replicaId,
              publicationDatabaseIdentity: "/foreign/project.sqlite",
            },
          ]) {
            writeLocalJson(join(replica.directory, "progress.json"), {
              ...current,
              ...scope,
              afterSequence: 999,
              exportedCount: 99,
            });
            const engine = boundedEngine(replica, fixture.signal);
            expect(engine.progress).toMatchObject({
              publicationReplicaId: replica.replication.status().replicaId,
              publicationDatabaseIdentity: replica.replication.databaseIdentity,
              afterSequence: 0,
              exportedCount: 0,
              publicationWindow: null,
            });
            expect(replica.db.getReplicationOutbox()).toEqual(pending);
          }
          fixture.phase("act/publish-own-queue");
          await boundedEngine(replica, fixture.signal).run();
          fixture.phase("assert/published-sources");
          expect(replica.replication.status().pending).toBe(0);
          expect(
            replica.replication
              .acceptedSnapshot()
              ?.publication?.changes.map((entry) => entry.source),
          ).toEqual(pending);
        },
        artifacts,
        { name: "bounded-scope", deadlineMs: windowDeadlineMs },
      );
    },
    windowDeadlineMs + GIT_FIXTURE_DRAIN_MS,
  );
});
