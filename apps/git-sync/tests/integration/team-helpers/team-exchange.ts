import { expect } from "bun:test";
import { TwoWriterBarrier } from "./publication-barrier";
import type { TeamFixture, TeamReplica } from "./team-fixture.types";

/**
 * Требует подготовленного участника; ошибка fixture не превращается в optional-assert.
 */
export function participant(team: TeamFixture, index: number): TeamReplica {
  const replica = team.replicas[index];
  if (replica === undefined) {
    throw new Error(`Не создан участник ${index}`);
  }
  return replica;
}

/**
 * Публикует два готовых кандидата на одном HEAD и доказывает настоящий non-FF второго.
 * Все процессы ограничены deadline fixture; при отказе ждёт остановки обеих попыток.
 */
export async function publishCompetingPair(team: TeamFixture): Promise<void> {
  const first = participant(team, 0);
  const second = participant(team, 1);
  const barrier = new TwoWriterBarrier(team.signal);
  first.repository.gateNextPush(barrier, "first");
  second.repository.gateNextPush(barrier, "second");
  try {
    const results = await Promise.allSettled(
      [first.engine.run(), second.engine.run()].map((attempt) =>
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
  const firstPush = first.repository.publications[0];
  const secondPush = second.repository.publications[0];
  if (!firstPush || !secondPush) {
    throw new Error("Оба участника должны попытаться опубликовать кандидат");
  }
  expect(firstPush.parent).not.toBeNull();
  expect(secondPush.parent).toBe(firstPush.parent);
  expect(firstPush.exitCode).toBe(0);
  expect(secondPush.exitCode).not.toBe(0);
  expect(secondPush.stdout).toMatch(/\[rejected\].*(fetch first|non-fast-forward)/);
  expect(second.repository.publications).toHaveLength(2);
  expect(second.repository.publications[1]?.exitCode).toBe(0);
  expect(second.repository.publications[1]?.parent).toBe(firstPush.commit);
}

/**
 * Повторяет A → B → A после сходимости и проверяет локальные CAS, поколения и Git HEAD.
 */
export async function expectNoEcho(team: TeamFixture): Promise<void> {
  const first = participant(team, 0);
  const second = participant(team, 1);
  const firstBefore = first.replication.core.capture();
  const secondBefore = second.replication.core.capture();
  const firstIds = firstBefore.entities.map((entry) => entry.record.id);
  const secondIds = secondBefore.entities.map((entry) => entry.record.id);
  // Portable DTO исключает локальный CAS: его неизменность проверяем отдельно в каждой БД.
  const firstLocal = first.db.getMany(firstIds);
  const secondLocal = second.db.getMany(secondIds);
  const generations = [first.db.getGeneration(), second.db.getGeneration()];
  const head = await team.originGit(["rev-parse", `refs/heads/${team.branch}`]);

  await first.engine.run();
  await second.engine.run();
  await first.engine.run();

  expect(first.replication.core.capture()).toEqual(firstBefore);
  expect(second.replication.core.capture()).toEqual(secondBefore);
  expect(first.db.getMany(firstIds)).toEqual(firstLocal);
  expect(second.db.getMany(secondIds)).toEqual(secondLocal);
  expect([first.db.getGeneration(), second.db.getGeneration()]).toEqual(generations);
  expect(first.db.getReplicationOutbox()).toEqual([]);
  expect(second.db.getReplicationOutbox()).toEqual([]);
  expect(await team.originGit(["rev-parse", `refs/heads/${team.branch}`])).toBe(head);
}
