import { describe, expect, test } from "bun:test";
import { realpathSync, statSync } from "node:fs";
import { BatchService, KnowledgeService, TasksService } from "@relay/core";
import { exchangeTeam, withTeamFixture } from "./team-helpers/team-fixture";
import { expectNoEcho, publishCompetingPair } from "./team-helpers/team-exchange";
import { resolveTeamConflict } from "./team-helpers/team-conflict";
import { crashDuringTeamPublication } from "./team-helpers/team-recovery";
import {
  comparableSnapshot,
  expectAcknowledged,
  expectTeamConverged,
  publishedSnapshot,
  storedEntity,
} from "./team-helpers/team-state";
import {
  createIndependentWork,
  createOffline,
  expectCreationsPreserved,
  expectIndependentWorkPreserved,
} from "./team-helpers/team-work";

const LATE_NAME = "Позднее имя после подготовки Git-кандидата";

/**
 * Общий бюджет трёх конечных волн: подготовка и гонка ключей; crash/conflict двух писателей;
 * возвращение offline-реплики, restore и no-echo. Включает fresh helper и все assertions.
 * Един для всех ОС, не перезапускается между волнами и не задаёт SLA отдельного обмена.
 * Короткие deadlines Git, actor и барьера продолжают обнаруживать локальное зависание.
 */
const SCENARIO_DEADLINE_MS = 90_000;

/**
 * Запас после управляемой отмены на завершение actors, engines, guardian и закрытие файлов.
 */
const CLEANUP_GRACE_MS = 15_000;
const TEST_WATCHDOG_MS = SCENARIO_DEADLINE_MS + CLEANUP_GRACE_MS;

describe("Обмен трёх независимых реплик через одну Git-ветку", () => {
  test(
    "два писателя и offline-участник сохраняют данные после non-FF, crash, конфликта и возвращения",
    async () => {
      await withTeamFixture(
        async (team) => {
          const first = await team.replica();
          const commonTask = await new TasksService(first.db).create(
            { title: "Общая задача" },
            "seed",
          );
          const commonDocument = await new KnowledgeService(first.db).create(
            "document",
            { name: "Общий текст", body: "Исходный общий текст\r\n" },
            "seed",
          );
          const changesets = [...first.db.getReplicationOutbox()];
          await first.engine.run();
          const baseline = await publishedSnapshot(first);
          const second = await team.replica(baseline);
          const offline = await team.replica(baseline);

          expect(team.replicas).toHaveLength(3);
          expect(
            new Set(team.replicas.map((replica) => replica.replication.core.status().replicaId))
              .size,
          ).toBe(3);
          expect(new Set(team.replicas.map((replica) => realpathSync(replica.db.path))).size).toBe(
            3,
          );
          expect(
            new Set(
              team.replicas.map((replica) => realpathSync(replica.repository.options.directory)),
            ).size,
          ).toBe(3);
          expect(new Set(team.replicas.map((replica) => realpathSync(replica.home))).size).toBe(3);
          expect(
            new Set(team.replicas.map((replica) => realpathSync(replica.relayHome))).size,
          ).toBe(3);
          for (const replica of team.replicas) {
            expect(statSync(replica.db.path).isFile()).toBe(true);
            expect(replica.db.projectId).toBe(baseline.projectId);
            expect(comparableSnapshot(replica.replication.core.capture())).toEqual(
              comparableSnapshot(baseline),
            );
          }

          const firstCreation = await createOffline(first);
          const secondCreation = await createOffline(second);
          const offlineCreation = await createOffline(offline);
          const creations = [firstCreation, secondCreation, offlineCreation];
          expect(creations.map((entry) => entry.document.key)).toEqual(["DOC-2", "DOC-2", "DOC-2"]);
          expect(creations.map((entry) => entry.task.key)).toEqual([
            "PRODUCT-2",
            "PRODUCT-2",
            "PRODUCT-2",
          ]);
          changesets.push(...creations.flatMap((entry) => entry.changesets));

          // Барьер допускает оба готовых кандидата с одним parent; первый push закрепляет ключи.
          first.repository.publications.length = 0;
          await publishCompetingPair(team);
          await offline.engine.run();
          await exchangeTeam([first, second]);

          const afterCreation = await publishedSnapshot(first);
          expectCreationsPreserved(afterCreation, creations, firstCreation);
          expect(
            creations.map((entry) => storedEntity(afterCreation, entry.document.id).record.key),
          ).toEqual(["DOC-2", "DOC-3", "DOC-4"]);
          expect(
            creations.map((entry) => storedEntity(afterCreation, entry.task.id).record.key),
          ).toEqual(["PRODUCT-2", "PRODUCT-3", "PRODUCT-4"]);
          expectTeamConverged(team.replicas, afterCreation);

          const firstWork = await createIndependentWork(first, firstCreation, commonTask.id);
          const secondWork = await createIndependentWork(second, secondCreation, commonTask.id);
          const offlineWork = await createIndependentWork(offline, offlineCreation, commonTask.id);
          const work = [firstWork, secondWork, offlineWork];
          changesets.push(...work.flatMap((entry) => entry.changesets));
          await new TasksService(first.db).update(
            commonTask.id,
            { title: "Общая задача с сохранёнными комментариями" },
            { actor: "participant-0", ifRevision: commonTask.revision },
          );
          const contentChange = first.db.getReplicationOutbox().at(-1);
          if (contentChange === undefined) {
            throw new Error("Нет транзакции изменения содержания общей задачи");
          }
          changesets.push(contentChange);
          const offlineQueue = offline.db.getReplicationOutbox();
          const offlineId = offline.replication.core.status().replicaId;
          const offlineSnapshot = offline.replication.core.capture();
          team.reopen(offline);
          expect(offline.replication.core.status().replicaId).toBe(offlineId);
          expect(offline.db.getReplicationOutbox()).toEqual(offlineQueue);
          expect(offline.replication.core.capture()).toEqual(offlineSnapshot);

          // Третий участник остаётся без обмена до завершения конфликтной волны двух писателей.
          first.repository.loseNextSuccessfulReply = true;
          await first.engine.run();
          expect(first.repository.lostReplies).toBe(1);
          expect(first.replication.core.status().pending).toBe(0);
          changesets.push(
            await crashDuringTeamPublication(team, second, secondCreation.document.id, LATE_NAME),
          );
          await first.engine.run();
          const resolved = await resolveTeamConflict(first, second, commonDocument, firstCreation);
          changesets.push(...resolved.changesets);

          const beforeReturn = await publishedSnapshot(first);
          expect(beforeReturn.comments).toHaveLength(2);
          expect(beforeReturn.receipts).toHaveLength(3);
          expect(offline.replication.core.status()).toMatchObject({
            replicaId: offlineId,
            pending: 3,
          });
          expect(offline.db.getReplicationOutbox()).toEqual(offlineQueue);
          expect(offline.replication.core.capture()).toEqual(offlineSnapshot);
          expect(new TasksService(offline.db).comments(commonTask.id)).toEqual([
            offlineWork.comment,
          ]);
          expect(
            new KnowledgeService(offline.db).get("document", commonDocument.id).data.body,
          ).toBe("Исходный общий текст\r\n");
          for (const change of offlineQueue) {
            expectAcknowledged(beforeReturn, change, false);
          }

          await offline.engine.run();
          const published = await publishedSnapshot(offline);
          const previousReplicaId = second.replication.core.status().replicaId;
          team.restore(second, published);
          expect(second.replication.core.status().replicaId).not.toBe(previousReplicaId);
          expect(
            new Set(team.replicas.map((replica) => replica.replication.core.status().replicaId))
              .size,
          ).toBe(3);
          expect(second.db.projectId).toBe(baseline.projectId);
          expect(second.db.getReplicationOutbox()).toEqual([]);
          expect(comparableSnapshot(second.replication.core.capture())).toEqual(
            comparableSnapshot(published),
          );
          await exchangeTeam([first, second]);

          expect(
            published.entities.filter((entry) => entry.record.kind === "document"),
          ).toHaveLength(4);
          expect(published.entities.filter((entry) => entry.record.kind === "task")).toHaveLength(
            4,
          );
          expect(published.receipts).toHaveLength(4);
          expectCreationsPreserved(published, creations, firstCreation);
          expectIndependentWorkPreserved(published, creations, work, commonTask.id);
          expect(storedEntity(published, secondCreation.document.id).record.data.name).toBe(
            LATE_NAME,
          );
          expect(storedEntity(published, commonTask.id).record.data.title).toBe(
            "Общая задача с сохранёнными комментариями",
          );
          expect(storedEntity(published, commonDocument.id).record.data).toMatchObject({
            body: "Локальный несовместимый текст\r\n",
            summary: "Зависит от локального текста",
          });
          for (const change of changesets) {
            expectAcknowledged(published, change, true);
          }
          expect(
            published.confirmations
              .flatMap((entry) =>
                (entry.proofs ?? []).map((proof) => `${entry.replicaId}:${proof.sequence}`),
              )
              .sort(),
          ).toEqual(changesets.map((change) => change.id).sort());
          expectTeamConverged(team.replicas, published);
          const referenceComments = new TasksService(first.db).comments(commonTask.id);
          expect(referenceComments).toHaveLength(3);
          expect(new Set(referenceComments.map((comment) => comment.id)).size).toBe(3);
          for (const operation of work) {
            expect(
              referenceComments.find((comment) => comment.id === operation.comment.id),
            ).toEqual(operation.comment);
          }
          for (const replica of team.replicas) {
            expect(new TasksService(replica.db).comments(commonTask.id)).toEqual(referenceComments);
            const batch = new BatchService(replica.db);
            for (const operation of work) {
              expect(batch.getResult(operation.operationKey)).toEqual({
                ...operation.result,
                replayed: true,
              });
            }
            expect(batch.getResult(resolved.operationKey)).toEqual({
              ...resolved.result,
              replayed: true,
            });
          }
          const returnedBeforeIdle = offline.replication.core.capture();
          const returnedIds = returnedBeforeIdle.entities.map((entry) => entry.record.id);
          const returnedLocal = offline.db.getMany(returnedIds);
          const returnedGeneration = offline.db.getGeneration();
          const head = await team.originGit(["rev-parse", `refs/heads/${team.branch}`]);

          await expectNoEcho(team);
          await offline.engine.run();

          expect(offline.replication.core.capture()).toEqual(returnedBeforeIdle);
          expect(offline.db.getMany(returnedIds)).toEqual(returnedLocal);
          expect(offline.db.getGeneration()).toBe(returnedGeneration);
          expect(offline.db.getReplicationOutbox()).toEqual([]);
          expect(await team.originGit(["rev-parse", `refs/heads/${team.branch}`])).toBe(head);
          expect(await team.originGit(["for-each-ref", "--format=%(refname)"])).toBe(
            `refs/heads/${team.branch}`,
          );
        },
        undefined,
        { deadlineMs: SCENARIO_DEADLINE_MS },
      );
    },
    TEST_WATCHDOG_MS,
  );
});
