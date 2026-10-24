import { expect } from "bun:test";
import type { ReplicationChangeset } from "@relay/contracts";
import { decodeSnapshot } from "../../../src/snapshot/codec";
import { observeExchangeDatabase } from "../helpers/crash-exchange-state";
import { expectAcknowledged, publishedSnapshot, storedEntity } from "./team-state";
import type { TeamFixture, TeamReplica } from "./team-fixture.types";

/**
 * Проверяет реальную смерть владельца после commit до push, поздний writer и новый процесс recovery.
 * Сохраняет исходную очередь и возвращает новый changeset для полного exact proof set команды.
 */
export async function crashDuringTeamPublication(
  team: TeamFixture,
  replica: TeamReplica,
  documentId: string,
  lateName: string,
): Promise<ReplicationChangeset> {
  const original = replica.db.getReplicationOutbox();
  const document = replica.db.get(documentId);
  if (original.length !== 3 || !document) {
    throw new Error("Crash-участник должен иметь три исходных пакета второй волны и свой документ");
  }
  const replicaId = replica.replication.status().replicaId;
  const remoteHead = await team.originGit(["rev-parse", `refs/heads/${team.branch}`]);

  const crashed = await team.exchangeInProcess(replica, {
    point: "before-push",
    lateCommand: {
      op: "document.update",
      ref: documentId,
      ifRevision: document.revision,
      input: { name: lateName },
    },
  });

  const late = crashed.lateChange;
  if (!late) {
    throw new Error("Crash-процесс не зафиксировал позднюю запись");
  }
  expect(observeExchangeDatabase(replica.db, replica.replication)).toEqual(crashed.state);
  expect(crashed.state.outbox).toEqual([...original, late]);
  expect(replica.replication.status().replicaId).toBe(replicaId);
  expect(await replica.repository.ref("refs/heads/data")).toBe(crashed.head);
  expect(await replica.repository.acceptedCommit()).toBe(remoteHead);
  expect(await team.originGit(["rev-parse", `refs/heads/${team.branch}`])).toBe(remoteHead);
  const candidate = decodeSnapshot(await replica.repository.files(crashed.head));
  expect(candidate.publication?.changes.map((entry) => entry.source)).toEqual(original);
  const remote = await publishedSnapshot(replica);
  for (const change of [...original, late]) {
    expectAcknowledged(remote, change, false);
    expectAcknowledged(crashed.state.snapshot, change, false);
  }
  expectAcknowledged(candidate, late, false);
  expect(storedEntity(candidate, documentId).record.data.name).toBe(document.data.name);
  expect(replica.db.get(documentId)?.data.name).toBe(lateName);

  const recovered = await team.exchangeInProcess(replica, { point: "complete" });

  expect(recovered.instance).not.toBe(crashed.instance);
  expect(recovered.beforePush).toEqual(crashed.state);
  expect(recovered.state.outbox).toEqual([]);
  expect(replica.replication.status().replicaId).toBe(replicaId);
  const published = await publishedSnapshot(replica);
  for (const change of [...original, late]) {
    expectAcknowledged(published, change, true);
  }
  expect(storedEntity(published, documentId).record.data.name).toBe(lateName);
  expect(await replica.repository.acceptedCommit()).toBe(recovered.head);
  expect(await team.originGit(["rev-parse", `refs/heads/${team.branch}`])).toBe(recovered.head);
  return late;
}
