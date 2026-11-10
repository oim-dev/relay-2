import { describe, expect, test } from "bun:test";
import { realpathSync, statSync } from "node:fs";
import { BatchService, KnowledgeService, TasksService } from "@relay/core";
import { exchangeTeam, withTeamFixture } from "../integration/team-helpers/team-fixture";
import { resolveTeamConflict } from "../integration/team-helpers/team-conflict";
import { crashDuringTeamPublication } from "../integration/team-helpers/team-recovery";
import {
  expectNoEcho,
  participant,
  publishCompetingPair,
} from "../integration/team-helpers/team-exchange";
import {
  comparableSnapshot,
  expectAcknowledged,
  expectTeamConverged,
  publishedSnapshot,
  storedEntity,
} from "../integration/team-helpers/team-state";
import {
  createIndependentWork,
  createOffline,
  expectCreationsPreserved,
  expectIndependentWorkPreserved,
} from "../integration/team-helpers/team-work";
import type {
  IndependentWork,
  OfflineCreation,
} from "../integration/team-helpers/team-scenario.types";

const TEAM_SIZE = 50;
const WINNER_INDEX = 7;
const CRASH_INDEX = 2;
const LATE_NAME = "Позднее имя после подготовки Git-кандидата";

describe("AC-50: конечный обмен независимой команды через одну Git-ветку", () => {
  test("50 offline-участников сохраняют ID, связи и квитанции после non-FF, crash, поздней записи, конфликта и restore", async () => {
    await withTeamFixture(async (team) => {
      const first = await team.replica();
      const commonTask = await new TasksService(first.db).create({ title: "Общая задача" }, "seed");
      const commonDocument = await new KnowledgeService(first.db).create(
        "document",
        { name: "Общий текст", body: "Исходный общий текст\r\n" },
        "seed",
      );
      const changesets = [...first.db.getReplicationOutbox()];
      await first.engine.run();
      const baseline = await publishedSnapshot(first);
      for (let index = 1; index < TEAM_SIZE; index++) {
        await team.replica(baseline);
      }
      expect(
        new Set(team.replicas.map((replica) => replica.replication.core.status().replicaId)).size,
      ).toBe(50);
      expect(new Set(team.replicas.map((replica) => realpathSync(replica.db.path))).size).toBe(50);
      expect(
        new Set(team.replicas.map((replica) => realpathSync(replica.repository.options.directory)))
          .size,
      ).toBe(50);
      expect(new Set(team.replicas.map((replica) => replica.home)).size).toBe(50);
      expect(new Set(team.replicas.map((replica) => replica.relayHome)).size).toBe(50);
      for (const replica of team.replicas) {
        expect(statSync(replica.db.path).isFile()).toBe(true);
        expect(replica.db.projectId).toBe(baseline.projectId);
        expect(comparableSnapshot(replica.replication.core.capture())).toEqual(
          comparableSnapshot(baseline),
        );
      }
      const creations: OfflineCreation[] = [];
      for (const replica of team.replicas) {
        creations.push(await createOffline(replica));
      }
      expect(new Set(creations.map((entry) => entry.document.key))).toEqual(new Set(["DOC-2"]));
      expect(new Set(creations.map((entry) => entry.task.key))).toEqual(new Set(["PRODUCT-2"]));
      changesets.push(...creations.flatMap((entry) => entry.changesets));

      const winner = participant(team, WINNER_INDEX);
      await winner.engine.run();
      expect(winner.replication.core.status().pending).toBe(0);
      // Первый принятый DOC-2 уже определён; следующая пара намеренно делит один parent.
      first.repository.publications.length = 0;
      await publishCompetingPair(team);
      for (const replica of team.replicas.filter(
        (entry) => ![0, 1, WINNER_INDEX].includes(entry.index),
      )) {
        await replica.engine.run();
      }
      await exchangeTeam(team.replicas);

      const afterCreation = await publishedSnapshot(first);
      const winnerCreation = creations[WINNER_INDEX];
      if (winnerCreation === undefined) {
        throw new Error("Нет исходного результата первого winner");
      }
      expectCreationsPreserved(afterCreation, creations, winnerCreation);
      expectTeamConverged(team.replicas, afterCreation);
      for (const change of changesets) {
        expectAcknowledged(afterCreation, change, true);
      }

      const work: IndependentWork[] = [];
      for (const [index, replica] of team.replicas.entries()) {
        const initial = creations[index];
        if (initial === undefined) {
          throw new Error("Нет offline-результата участника");
        }
        work.push(await createIndependentWork(replica, initial, commonTask.id));
      }
      changesets.push(...work.flatMap((entry) => entry.changesets));
      const changedCommon = await new TasksService(first.db).update(
        commonTask.id,
        { title: "Общая задача с сохранёнными комментариями" },
        { actor: "participant-0", ifRevision: commonTask.revision },
      );
      const contentChange = first.db.getReplicationOutbox().at(-1);
      if (!contentChange) {
        throw new Error("Нет транзакции изменения содержания общей задачи");
      }
      changesets.push(contentChange);
      const offline = participant(team, 49);
      const offlineQueue = offline.db.getReplicationOutbox();
      const offlineId = offline.replication.core.status().replicaId;
      team.reopen(offline);
      expect(offline.replication.core.status().replicaId).toBe(offlineId);
      expect(offline.db.getReplicationOutbox()).toEqual(offlineQueue);
      // Потерянный ответ касается уже принятого пакета с комментарием и пользовательской квитанцией.
      winner.repository.loseNextSuccessfulReply = true;
      // Два последних участника пропускают и эту волну, и последующее разрешение конфликта.
      for (const replica of team.replicas.slice(0, 48)) {
        if (replica.index === CRASH_INDEX) {
          const creation = creations[CRASH_INDEX];
          if (!creation) {
            throw new Error("Нет исходного документа crash-участника");
          }
          changesets.push(
            await crashDuringTeamPublication(team, replica, creation.document.id, LATE_NAME),
          );
        } else {
          await replica.engine.run();
        }
      }
      expect(winner.repository.lostReplies).toBe(1);
      expect(winner.replication.core.status().pending).toBe(0);
      await exchangeTeam(team.replicas.slice(0, 2));
      const own = creations[0];
      if (!own) {
        throw new Error("Нет собственной пары проигрывающего участника");
      }
      const resolved = await resolveTeamConflict(first, participant(team, 1), commonDocument, own);
      changesets.push(...resolved.changesets);

      const beforeReturn = await publishedSnapshot(first);
      expect(beforeReturn.comments).toHaveLength(48);
      for (const replica of team.replicas.slice(48)) {
        expect(replica.replication.core.status().pending).toBe(3);
        for (const change of replica.db.getReplicationOutbox()) {
          expectAcknowledged(beforeReturn, change, false);
        }
        await replica.engine.run();
      }
      const published = await publishedSnapshot(first);
      const restored = participant(team, 47);
      const previousReplicaId = restored.replication.core.status().replicaId;
      team.restore(restored, published);
      expect(restored.replication.core.status().replicaId).not.toBe(previousReplicaId);
      expect(
        new Set(team.replicas.map((replica) => replica.replication.core.status().replicaId)).size,
      ).toBe(50);
      expect(restored.db.projectId).toBe(baseline.projectId);
      expect(restored.db.getReplicationOutbox()).toEqual([]);
      expect(comparableSnapshot(restored.replication.core.capture())).toEqual(
        comparableSnapshot(published),
      );
      await exchangeTeam(team.replicas);

      expect(published.entities.filter((entry) => entry.record.kind === "document")).toHaveLength(
        51,
      );
      expect(published.entities.filter((entry) => entry.record.kind === "task")).toHaveLength(51);
      expect(published.receipts).toHaveLength(51);
      expectCreationsPreserved(published, creations, winnerCreation);
      expectIndependentWorkPreserved(published, creations, work, commonTask.id);
      const crashCreation = creations[CRASH_INDEX];
      if (!crashCreation) {
        throw new Error("Нет исходного документа crash-участника");
      }
      expect(storedEntity(published, crashCreation.document.id).record.data.name).toBe(LATE_NAME);
      expect(storedEntity(published, commonTask.id).record.data.title).toBe(
        changedCommon.data.title,
      );
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
      expect(referenceComments).toHaveLength(TEAM_SIZE);
      expect(new Set(referenceComments.map((comment) => comment.id)).size).toBe(TEAM_SIZE);
      for (const operation of work) {
        expect(referenceComments.find((comment) => comment.id === operation.comment.id)).toEqual(
          operation.comment,
        );
      }
      for (const replica of team.replicas) {
        // Равенство portable-набора не доказывает одинаковый порядок публичного журнала.
        expect(
          new TasksService(replica.db).comments(commonTask.id),
          `Порядок и содержание комментариев участника ${replica.index}`,
        ).toEqual(referenceComments);
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
      await expectNoEcho(team);
      expect(await team.originGit(["for-each-ref", "--format=%(refname)"])).toBe(
        `refs/heads/${team.branch}`,
      );
    });
  }, 270_000);
});
