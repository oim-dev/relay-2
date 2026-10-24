import assert from "node:assert/strict";
import { RelayError } from "@relay/contracts";
import type { GitSyncEnvironment } from "./client.types";
import type { ProcessResult } from "./process.types";
import { createServiceConfiguration } from "./service-configuration";
import { windowsService } from "./service-windows";
import type { NativeServiceStatus } from "./service.types";

// Подмены часов принадлежат только этому отдельному процессу, не процессу bun test и не ОС.
const scenario = process.argv[2];
assert.ok(
  [
    "rollback",
    "fractional",
    "expired-before-probe",
    "expired-after-probe",
    "cancelled",
    "cancelled-at-deadline",
    "lock-timeout",
    "lock-expired-after-probe",
    "lock-cancelled",
  ].includes(scenario ?? ""),
);
const configuration = createServiceConfiguration({
  platform: "win32",
  binary: "C:\\Relay\\sync.exe",
  home: "C:\\fixture\\home",
  userHome: "C:\\Users\\fixture",
  userName: "TEAM\\fixture",
});
const configuredBudget = 100;
const cancellation = new AbortController();
const mutations: string[] = [];
const pollBudgets: number[] = [];
let monotonic = 10.25;
let wallClock = 1_000_000;
let ended = false;
let stopped = false;
let created = false;
let running = true;
let signalsPreserved = true;

/**
 * Возвращает управляемое дробное монотонное время; native-события ниже продвигают его явно.
 */
function monotonicNow(): number {
  return monotonic;
}

/**
 * Имитирует коррекцию wall clock назад без изменения системных часов.
 */
function wallClockNow(): number {
  return wallClock;
}

const environment: GitSyncEnvironment = {
  cwd: "C:\\fixture",
  env: {},
  executablePath: "C:\\Relay\\relay.exe",
  userHome: "C:\\Users\\fixture",
  version: "0.0.0",
  timeoutMs: configuredBudget,
  signal: cancellation.signal,
  /**
   * Имитирует занятость после завершения manager, расходуя тот же бюджет либо отменяя ожидание.
   */
  supervisorLockProbe(): "free" | "busy" {
    assert.ok(stopped);
    if (scenario === "lock-timeout") {
      monotonic = 110.5;
      return "busy";
    }
    if (scenario === "lock-expired-after-probe") {
      monotonic = 110.5;
      return "free";
    }
    if (scenario === "lock-cancelled") {
      cancellation.abort("SIGTERM");
      return "busy";
    }
    return "free";
  },
  /**
   * Возвращает только in-memory COM-ответы. Ни одна ОС-команда не запускается.
   * Лишний poll завершается ошибкой, чтобы регрессия старого deadline не зависла.
   */
  async runner(command): Promise<ProcessResult> {
    signalsPreserved &&= command.signal === cancellation.signal;
    assert.ok(
      typeof command.timeoutMs === "number" &&
        Number.isSafeInteger(command.timeoutMs) &&
        command.timeoutMs > 0,
    );
    if (command.executable === "schtasks.exe") {
      const action = command.args[0];
      assert.ok(action);
      mutations.push(action);
      if (action === "/End") {
        ended = true;
        wallClock -= 60_000;
        monotonic = 35.75;
        if (scenario === "fractional") {
          monotonic = 110;
        } else if (scenario === "expired-before-probe") {
          monotonic = 110.5;
        }
      } else if (action === "/Create") {
        assert.ok(stopped);
        created = true;
      } else if (action === "/Run") {
        assert.ok(created);
        running = true;
      } else {
        throw new Error(`Непредусмотренная мутация ${action}`);
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    }
    assert.equal(command.executable, "powershell.exe");
    if (ended && !created) {
      assert.notEqual(scenario, "expired-before-probe", "Native poll после исчерпания stop budget");
      assert.equal(pollBudgets.length, 0, "Повторный native poll после исчерпания stop budget");
      pollBudgets.push(command.timeoutMs);
      if (scenario === "expired-after-probe") {
        monotonic = 110.5;
      } else if (scenario === "cancelled" || scenario === "cancelled-at-deadline") {
        if (scenario === "cancelled-at-deadline") {
          monotonic = 110.5;
        }
        cancellation.abort("SIGTERM");
      } else {
        stopped = true;
        running = false;
      }
    }
    return {
      exitCode: 0,
      stderr: "",
      stdout: JSON.stringify({
        exists: true,
        description: configuration.marker,
        enabled: true,
        state: running ? 4 : 3,
        runningInstances: running ? 1 : 0,
      }),
    };
  },
};

const originalDateNow = Date.now;
const originalPerformanceNow = Object.getOwnPropertyDescriptor(performance, "now");
let status: NativeServiceStatus | undefined;
let failureCode: string | null = null;
let failureExit: number | null = null;
let failurePhase: unknown = null;
try {
  Date.now = wallClockNow;
  Object.defineProperty(performance, "now", { configurable: true, value: monotonicNow });
  try {
    status = await windowsService("enable", configuration, environment);
  } catch (error) {
    if (!(error instanceof RelayError)) {
      throw error;
    }
    failureCode = error.code;
    failureExit = error.exitCode;
    failurePhase = error.details?.phase ?? null;
  }
} finally {
  Date.now = originalDateNow;
  if (originalPerformanceNow) {
    Object.defineProperty(performance, "now", originalPerformanceNow);
  } else {
    Reflect.deleteProperty(performance, "now");
  }
}
process.stdout.write(
  JSON.stringify({
    configuredBudget,
    wallClock,
    pollBudgets,
    mutations,
    signalsPreserved,
    registered: status?.registered ?? null,
    state: status?.state ?? null,
    failureCode,
    failureExit,
    failurePhase,
  }) + "\n",
);
