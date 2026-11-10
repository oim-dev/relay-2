import { describe, expect, test } from "bun:test";
import { synchronizationDueAt, synchronizationRetryDelay } from "./schedule";
import type { SynchronizationSchedule } from "@relay/storage";

const cases = [
  {
    name: "пустая очередь получает удалённые изменения по сроку polling",
    dirtySince: null,
    lastMutationAt: null,
    nextAttemptAt: 5000,
    expected: 5000,
  },
  {
    name: "серия записей ждёт две секунды тишины",
    dirtySince: 10_000,
    lastMutationAt: 11_000,
    nextAttemptAt: 0,
    expected: 13_000,
  },
  {
    name: "непрерывные записи ограничены десятью секундами от начала серии",
    dirtySince: 10_000,
    lastMutationAt: 19_000,
    nextAttemptAt: 0,
    expected: 20_000,
  },
  {
    name: "backoff сохраняется при новых локальных записях",
    dirtySince: 10_000,
    lastMutationAt: 11_000,
    nextAttemptAt: 50_000,
    expected: 50_000,
  },
] as const;

describe("Срок ленивой синхронизации", () => {
  test.each(cases)("$name", ({ name: _name, expected, ...times }) => {
    const state: SynchronizationSchedule = {
      ...times,
      mode: "auto",
      lastAttemptAt: null,
      failures: 0,
    };

    const actual = synchronizationDueAt(state);

    expect(actual).toBe(expected);
  });

  test("повтор после отказов ограничен минутой", () => {
    expect(synchronizationRetryDelay(0)).toBe(2000);
    expect(synchronizationRetryDelay(2)).toBe(8000);
    expect(synchronizationRetryDelay(20)).toBe(60_000);
  });

  test("manual запрещает автоматическую попытку даже при просроченной очереди", () => {
    expect(
      synchronizationDueAt({
        mode: "manual",
        dirtySince: 0,
        lastMutationAt: 0,
        nextAttemptAt: 0,
        lastAttemptAt: null,
        failures: 0,
      }),
    ).toBe(Number.POSITIVE_INFINITY);
  });
});
