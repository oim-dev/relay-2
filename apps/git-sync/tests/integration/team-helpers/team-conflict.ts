import { expect } from "bun:test";
import { BatchService, KnowledgeService, TasksService } from "@relay/core";
import type { KnowledgeRecord, ReplicationChangeset } from "@relay/contracts";
import type { TeamReplica } from "./team-fixture.types";
import type { OfflineCreation, ResolvedWork } from "./team-scenario.types";
import { expectAcknowledged, publishedSnapshot, storedEntity } from "./team-state";

/**
 * Сохраняет разные body общего документа, зависимую транзакцию и независимую позднюю правку.
 * Первый эффект конфликтного batch должен удержать второй эффект и receipt в том же пакете.
 * Каждая запись ожидается до следующего чтения и возврата управления fixture.
 */
async function createConflictingWork(
  loser: TeamReplica,
  winner: TeamReplica,
  common: KnowledgeRecord<"document">,
  own: OfflineCreation,
): Promise<ResolvedWork> {
  const left = new KnowledgeService(loser.db);
  const right = new KnowledgeService(winner.db);
  const baseLeft = left.get("document", common.id);
  const task = new TasksService(loser.db).get(own.task.id);
  const operationKey = "team-conflict-atomic";
  const result = await new BatchService(loser.db).execute(
    {
      version: 1,
      operations: [
        {
          op: "document.update",
          ref: common.id,
          ifRevision: baseLeft.revision,
          input: { body: "Локальный несовместимый текст\r\n" },
        },
        {
          op: "task.update",
          ref: task.id,
          ifRevision: task.revision,
          input: { description: "Атомарный спутник конфликтного текста" },
        },
      ],
    },
    { actor: "loser", operationKey },
  );
  const changed = left.get("document", common.id);
  await left.update(
    "document",
    common.id,
    { summary: "Зависит от локального текста" },
    { actor: "loser", ifRevision: changed.revision },
  );
  const independent = left.get("document", own.document.id);
  await left.update(
    "document",
    independent.id,
    { summary: "Независимая правка после конфликта" },
    { actor: "loser", ifRevision: independent.revision },
  );
  const baseRight = right.get("document", common.id);
  await right.update(
    "document",
    common.id,
    { body: "Удалённый несовместимый текст\r\n" },
    { actor: "winner", ifRevision: baseRight.revision },
  );
  return {
    operationKey,
    result,
    changesets: [...loser.db.getReplicationOutbox(), ...winner.db.getReplicationOutbox()],
  };
}

/**
 * Проверяет действительный конфликт и продвижение независимой цепочки через одну Git-ветку,
 * затем применяет актуальное решение Core и доставляет оба ранее заблокированных changeset.
 */
export async function resolveTeamConflict(
  loser: TeamReplica,
  winner: TeamReplica,
  common: KnowledgeRecord<"document">,
  own: OfflineCreation,
): Promise<ResolvedWork> {
  const work = await createConflictingWork(loser, winner, common, own);
  const [conflicting, dependent, independent, acceptedWinner] = work.changesets;
  if (!conflicting || !dependent || !independent || !acceptedWinner) {
    throw new Error("Не сформированы четыре ожидаемые транзакции конфликтной волны");
  }
  expect(work.changesets).toHaveLength(4);
  expect(conflicting.entities.map((entry) => entry.id).sort()).toEqual(
    [common.id, own.task.id].sort(),
  );
  expect(dependent.dependencies).toContain(conflicting.id);
  expect(independent.dependencies).not.toContain(conflicting.id);
  expect(independent.dependencies).not.toContain(dependent.id);

  await winner.engine.run();
  await loser.engine.run();

  const published = await publishedSnapshot(winner);
  expectAcknowledged(published, acceptedWinner, true);
  expectAcknowledged(published, independent, true);
  expectAcknowledged(published, conflicting, false);
  expectAcknowledged(published, dependent, false);
  expect(storedEntity(published, common.id).record.data).toMatchObject({
    body: "Удалённый несовместимый текст\r\n",
    summary: "",
  });
  expect(storedEntity(published, own.task.id).record.data.description).toBe(
    "Пакет 0: сохранены обе стороны",
  );
  expect(storedEntity(published, own.document.id).record.data.summary).toBe(
    "Независимая правка после конфликта",
  );
  expect(published.receipts.some((receipt) => receipt.operationKey === work.operationKey)).toBe(
    false,
  );
  expect(loser.db.getReplicationOutbox()).toEqual([conflicting, dependent]);
  expect(new BatchService(loser.db).getResult(work.operationKey)).toEqual({
    ...work.result,
    replayed: true,
  });
  expectConflictMaterial(loser, common, conflicting, dependent);

  const current = loser.replication.core.conflicts().find((entry) => entry.id === conflicting.id);
  if (current === undefined) {
    throw new Error("Нет актуального конфликта для явного решения");
  }
  const decision = loser.replication.core.resolve(
    current.id,
    { fingerprint: current.fingerprint, choice: "local" },
    "resolver",
  );
  expect(decision.conflicts).toEqual([]);
  expect(decision.included).toEqual([conflicting.id, dependent.id]);
  expect(loser.replication.core.status().pending).toBe(2);
  expect(loser.db.getReplicationOutbox()).toEqual([conflicting, dependent]);
  await loser.engine.run();

  const resolved = await publishedSnapshot(loser);
  expectAcknowledged(resolved, conflicting, true);
  expectAcknowledged(resolved, dependent, true);
  expect(storedEntity(resolved, common.id).record.data).toMatchObject({
    body: "Локальный несовместимый текст\r\n",
    summary: "Зависит от локального текста",
  });
  expect(storedEntity(resolved, own.task.id).record.data.description).toBe(
    "Атомарный спутник конфликтного текста",
  );
  expect(resolved.receipts.find((entry) => entry.operationKey === work.operationKey)).toEqual(
    conflicting.receipts[0],
  );
  expect(loser.replication.core.status()).toMatchObject({ pending: 0, conflicts: 0 });
  expect(loser.replication.core.blocked()).toEqual([]);
  return work;
}

/**
 * Сопоставляет полные три стороны с исходными командами, а зависимый пакет — с точным ID причины.
 */
function expectConflictMaterial(
  loser: TeamReplica,
  common: KnowledgeRecord<"document">,
  conflicting: ReplicationChangeset,
  dependent: ReplicationChangeset,
): void {
  const conflicts = loser.replication.core.conflicts();
  expect(conflicts).toHaveLength(1);
  const blocked = loser.replication.core.blocked();
  expect(blocked).toHaveLength(1);
  const conflict = conflicts.find((entry) => entry.id === conflicting.id);
  if (conflict === undefined) {
    throw new Error("Потерян материал конфликта body");
  }
  expect(conflict.code).toBe("REPLICATION_CONFLICT");
  expect(conflict.fingerprint.length).toBeGreaterThan(0);
  expect(conflict.changeset).toEqual(conflicting);
  expect(
    conflict.changeset.entities.find((entry) => entry.id === common.id)?.before?.record.data.body,
  ).toBe(common.data.body);
  expect(
    conflict.changeset.entities.find((entry) => entry.id === common.id)?.after?.record.data.body,
  ).toBe("Локальный несовместимый текст\r\n");
  expect(conflict.local.find((entry) => entry.record.id === common.id)?.record.data).toMatchObject({
    body: "Локальный несовместимый текст\r\n",
    summary: "Зависит от локального текста",
  });
  expect(conflict.remote.find((entry) => entry.record.id === common.id)?.record.data.body).toBe(
    "Удалённый несовместимый текст\r\n",
  );
  expect(blocked[0]).toMatchObject({
    id: dependent.id,
    state: "pending",
    code: "REPLICATION_DEPENDENCY",
    dependencies: [conflicting.id],
  });
}
