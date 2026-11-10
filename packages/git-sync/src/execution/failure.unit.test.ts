import { describe, expect, test } from "bun:test";
import { RelayError } from "@relay/contracts";
import { combineProcessFailures } from "@relay/project-runtime";
import { executionFailure } from "./failure";

const callerSignals = [
  { name: "SIGTERM", reason: "SIGTERM", exitCode: 143 },
  { name: "SIGINT", reason: "SIGINT", exitCode: 130 },
  { name: "произвольная причина caller", reason: "Остановка вызывающего", exitCode: 130 },
] as const;

const protectedFailures = [
  { name: "неизвестный исход push", code: "GIT_PUSH_OUTCOME_UNKNOWN", exitCode: 4 },
  { name: "неподтверждённая очистка процессов", code: "GIT_CLEANUP_FAILED", exitCode: 1 },
  { name: "отказ guardian", code: "GIT_GUARDIAN_FAILED", exitCode: 1 },
  { name: "ошибка протокола guardian", code: "GIT_GUARDIAN_PROTOCOL", exitCode: 1 },
  {
    name: "незавершённая публикация восстановленной БД",
    code: "RESTORE_RECOVERY_REQUIRED",
    exitCode: 4,
  },
] as const;

describe("Классификация отказа библиотечного обращения Git Sync", () => {
  test("caller раньше deadline остаётся отменой после истечения обоих сигналов", () => {
    const caller = new AbortController();
    const deadline = new AbortController();
    const signal = AbortSignal.any([caller.signal, deadline.signal]);
    const cause = Object.freeze(new RelayError("GIT_CANCELLED", "Команда прервана", 1));
    caller.abort("SIGTERM");
    deadline.abort();

    const failure = executionFailure(cause, signal, deadline.signal);

    expect(failure).toMatchObject({ code: "GIT_SYNC_CANCELLED", exitCode: 143 });
    expect(failure instanceof Error && failure.cause).toBe(cause);
  });

  test("deadline раньше caller остаётся timeout после позднего SIGTERM", () => {
    const caller = new AbortController();
    const deadline = new AbortController();
    const signal = AbortSignal.any([caller.signal, deadline.signal]);
    const cause = Object.freeze(new RelayError("GIT_CANCELLED", "Команда прервана", 1));
    deadline.abort();
    caller.abort("SIGTERM");

    const failure = executionFailure(cause, signal, deadline.signal);

    expect(failure).toMatchObject({ code: "GIT_SYNC_TIMEOUT", exitCode: 124 });
    expect(failure instanceof Error && failure.cause).toBe(cause);
  });

  test.each(callerSignals)(
    "$name без deadline сохраняет exit code и исходный cause",
    ({ reason, exitCode }) => {
      const caller = new AbortController();
      const deadline = new AbortController();
      const cause = Object.freeze(new Error("Незавершённое чтение"));
      caller.abort(reason);

      const failure = executionFailure(cause, caller.signal, deadline.signal);

      expect(failure).toMatchObject({ code: "GIT_SYNC_CANCELLED", exitCode });
      expect(failure instanceof Error && failure.cause).toBe(cause);
    },
  );

  test("живой signal возвращает исходную предметную ошибку вместе с её native cause", () => {
    const signal = new AbortController();
    const deadline = new AbortController();
    const native = new Error("Исходная файловая ошибка");
    const cause = new RelayError("GIT_ORIGIN_MISMATCH", "Подменён remote", 4, { remote: "other" });
    cause.cause = native;
    Object.freeze(cause);

    const failure = executionFailure(cause, signal.signal, deadline.signal);

    expect(failure).toBe(cause);
    expect(cause.cause).toBe(native);
  });

  test("живой signal не превращает произвольный thrown value в инфраструктурный отказ", () => {
    const signal = new AbortController();
    const deadline = new AbortController();
    const cause = Object.freeze({ diagnostic: "Не-Error причина" });

    const failure = executionFailure(cause, signal.signal, deadline.signal);

    expect(failure).toBe(cause);
  });

  test.each(protectedFailures)("$name сохраняется вместо поздней отмены", ({ code, exitCode }) => {
    const caller = new AbortController();
    const deadline = new AbortController();
    const cause = new RelayError(code, "Значимый транспортный отказ", exitCode, {
      retained: "details",
    });
    cause.cause = new Error("Исходная причина транспорта");
    Object.freeze(cause);
    const signal = AbortSignal.any([caller.signal, deadline.signal]);
    caller.abort("SIGTERM");
    deadline.abort();

    const failure = executionFailure(cause, signal, deadline.signal);

    expect(failure).toBe(cause);
  });

  test("вторичный cleanup failure под кодом GIT_CANCELLED не маскируется отменой обращения", () => {
    const caller = new AbortController();
    const deadline = new AbortController();
    const primary = new RelayError("GIT_CANCELLED", "Команда прервана", 1);
    const cleanup = new RelayError("GIT_CLEANUP_FAILED", "Очистка не подтверждена", 1);
    const compound = combineProcessFailures(primary, cleanup);
    caller.abort("SIGTERM");

    const failure = executionFailure(compound, caller.signal, deadline.signal);

    expect(failure).toBe(compound);
    expect(compound.cause).toBeInstanceOf(AggregateError);
    expect(compound.cause).toMatchObject({ errors: [primary, cleanup] });
  });

  test("значимый отказ сохраняется через несколько составных causes без изменения исходных ошибок", () => {
    const caller = new AbortController();
    const deadline = new AbortController();
    const primary = Object.freeze(new RelayError("GIT_CANCELLED", "Ожидание прервано", 1));
    const guardian = Object.freeze(
      new RelayError("GIT_GUARDIAN_FAILED", "Guardian не подтвердил работу", 1),
    );
    const nested = combineProcessFailures(primary, guardian);
    const compound = Object.freeze(combineProcessFailures(primary, nested));
    caller.abort("SIGTERM");

    const failure = executionFailure(compound, caller.signal, deadline.signal);

    expect(failure).toBe(compound);
    expect(compound.cause).toMatchObject({ errors: [primary, nested] });
    expect(nested.cause).toMatchObject({ errors: [primary, guardian] });
  });

  test("циклический cause без значимого отказа не зацикливает классификацию отмены", () => {
    const caller = new AbortController();
    const deadline = new AbortController();
    const cause = new RelayError("GIT_CANCELLED", "Команда отменена", 1);
    cause.cause = cause;
    Object.freeze(cause);
    caller.abort("SIGTERM");

    const failure = executionFailure(cause, caller.signal, deadline.signal);

    expect(failure).toMatchObject({ code: "GIT_SYNC_CANCELLED", exitCode: 143 });
    expect(failure instanceof Error && failure.cause).toBe(cause);
  });
});
