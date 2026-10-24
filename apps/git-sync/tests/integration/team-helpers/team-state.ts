import { expect } from "bun:test";
import type { PortableEntity, PortableProjectSnapshot } from "@relay/contracts";
import { validateReplicationHistory } from "@relay/core";
import { decodeSnapshot } from "../../../src/snapshot/codec";
import { readPublicationHistory } from "../../../src/sync/publication-reader";
import type { ExpectedChangeset, TeamReplica } from "./team-fixture.types";
import type { CanonicalTeamState } from "./team-scenario.types";

/**
 * Читает фактически принятую ветку и проверяет публикации от известного принятого checkpoint.
 * Полученный снимок пригоден для trusted bootstrap: основание доверия — реальная Git/Core цепочка.
 */
export async function publishedSnapshot(replica: TeamReplica): Promise<PortableProjectSnapshot> {
  const head = await replica.repository.fetch();
  if (head === null) {
    throw new Error("У общей ветки отсутствует ожидаемая опубликованная версия");
  }
  return readPublicationHistory(
    replica.repository,
    head,
    {
      decode: decodeSnapshot,
      validate: validateReplicationHistory,
    },
    { projectId: replica.db.projectId, base: replica.replication.acceptedSnapshot() },
  );
}

/**
 * Требует конкретную сохранённую карточку; отсутствие не маскируется пустым ожидаемым значением.
 */
export function storedEntity(snapshot: PortableProjectSnapshot, id: string): PortableEntity {
  const entity = snapshot.entities.find((entry) => entry.record.id === id);
  if (entity === undefined) {
    throw new Error(`Опубликованная карточка ${id} отсутствует`);
  }
  return entity;
}

/**
 * Канонизирует ID-наборы предметного portable state, включая нормализованные parts и их версии.
 * Конверт publication проверен отдельно через Git history; локальный capture не обещает этот конверт.
 */
export function comparableSnapshot(snapshot: PortableProjectSnapshot): CanonicalTeamState {
  const { publication: _publication, ...state } = snapshot;
  return {
    ...state,
    ...(snapshot.components === undefined
      ? {}
      : {
          components: [...snapshot.components].sort((a, b) => {
            const left = JSON.stringify([a.ownerId, a.kind, a.id]);
            const right = JSON.stringify([b.ownerId, b.kind, b.id]);
            return left < right ? -1 : left > right ? 1 : 0;
          }),
        }),
    entities: [...snapshot.entities].sort((a, b) => (a.record.id < b.record.id ? -1 : 1)),
    addresses: [...snapshot.addresses].sort((a, b) => (a.ref < b.ref ? -1 : 1)),
    comments: [...snapshot.comments].sort((a, b) => (a.comment.id < b.comment.id ? -1 : 1)),
    receipts: [...snapshot.receipts].sort((a, b) => (a.operationKey < b.operationKey ? -1 : 1)),
    confirmations: [...snapshot.confirmations].sort((a, b) => (a.replicaId < b.replicaId ? -1 : 1)),
  };
}

/**
 * Проверяет точный ack ID/digest; отсутствие дыр в диапазоне само по себе не заменяет proof.
 */
export function expectAcknowledged(
  snapshot: PortableProjectSnapshot,
  change: ExpectedChangeset,
  accepted: boolean,
): void {
  const confirmation = snapshot.confirmations.find((entry) => entry.replicaId === change.replicaId);
  const inRange =
    confirmation?.ranges.some(
      ([start, end]) => start <= change.sequence && change.sequence <= end,
    ) ?? false;
  const proof = confirmation?.proofs?.find((entry) => entry.sequence === change.sequence);
  expect(inRange, `Подтверждение ${change.id}`).toBe(accepted);
  if (accepted) {
    expect(proof).toMatchObject({
      sequence: change.sequence,
      digest: change.digest,
      outcome: "applied",
    });
    if (!proof) {
      throw new Error(`Нет подтверждения ${change.id}`);
    }
    expect(typeof proof.publicationId).toBe("string");
    expect(proof.publicationId?.length).toBeGreaterThan(0);
    expect(proof.effectDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(
      proof.resolutionId === null ||
        (typeof proof.resolutionId === "string" && proof.resolutionId.length > 0),
    ).toBe(true);
  } else {
    expect(proof).toBeUndefined();
  }
}

/**
 * Сравнивает непустые переносимые состояния и требует завершённой доставки каждого участника.
 */
export function expectTeamConverged(
  replicas: readonly TeamReplica[],
  published: PortableProjectSnapshot,
): void {
  expect(published.entities.length).toBeGreaterThan(50);
  expect(published.modelVersion).toBe(2);
  expect(published.components?.length).toBeGreaterThan(0);
  const expected = comparableSnapshot(published);
  for (const replica of replicas) {
    expect(replica.replication.core.status(), `Очередь участника ${replica.index}`).toMatchObject({
      pending: 0,
      conflicts: 0,
    });
    expect(
      comparableSnapshot(replica.replication.core.capture()),
      `Экспорт участника ${replica.index}`,
    ).toEqual(expected);
  }
}
