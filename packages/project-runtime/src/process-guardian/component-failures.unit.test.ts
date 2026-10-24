import { describe, expect, test } from "bun:test";
import { RelayError } from "@relay/contracts";
import { combineProcessFailures } from "./component-failures";
import { GuardedCommandError } from "./errors";

describe("Основной и вторичный отказ process lifetime", () => {
  test("RelayError сохраняет code/exit/details и обе причины без мутации primary", () => {
    const native = new Error("Первоначальная причина");
    const primary = new RelayError("PRIMARY", "Основная ошибка", 4, { retained: "details" });
    primary.cause = native;
    Object.freeze(primary);
    const cleanup = Object.assign(new Error("Удаление запрещено"), { code: "EACCES" });

    const combined = combineProcessFailures(primary, cleanup);

    expect(combined).toBeInstanceOf(RelayError);
    expect(combined).toMatchObject({ code: "PRIMARY", exitCode: 4, message: primary.message });
    expect(Reflect.get(combined, "details")).toBe(primary.details);
    expect(combined.cause).toBeInstanceOf(AggregateError);
    expect(combined.cause).toMatchObject({ errors: [primary, cleanup] });
    expect(primary.cause).toBe(native);
  });

  test("типизированный native failure сохраняет reason, streams, stage/systemCode и цепочку", () => {
    const primary = new GuardedCommandError("spawn", {
      stdout: new Uint8Array([0, 255]),
      stderr: "частичная диагностика",
      stage: "command-spawn",
      systemCode: "ENOENT",
    });
    const cleanup = new Error("Cleanup failure");

    const combined = combineProcessFailures(primary, cleanup);

    expect(combined).toBeInstanceOf(GuardedCommandError);
    expect(combined).toMatchObject({
      reason: "spawn",
      stage: "command-spawn",
      systemCode: "ENOENT",
      stdout: primary.stdout,
      stderr: primary.stderr,
    });
    expect(combined.cause).toMatchObject({ errors: [primary, cleanup] });
    expect(primary.cause).toEqual({ stage: "command-spawn", systemCode: "ENOENT" });
  });

  test("не-Error thrown value тоже остаётся частью aggregate", () => {
    const cleanup = new Error("Ошибка cleanup");
    const combined = combineProcessFailures(undefined, cleanup);
    expect(combined).toBeInstanceOf(AggregateError);
    expect(combined).toMatchObject({ errors: [undefined, cleanup] });
  });
});
