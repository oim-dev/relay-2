import { join } from "node:path";
import {
  GuardedCommandError,
  runGuardedCommand,
  type RuntimeOptions,
} from "@relay/project-runtime";
import { controlRequest, readEndpoint, responsive } from "../../src/local/control";
import { waitUntil } from "../../src/local/deadline";
import type { TestSupervisor } from "./supervisor-fixture.types";

/**
 * Создаёт отдельный S под lease fixture, вне любого request job; native services не затрагивает.
 * Вызывающий закрывает S в finally до закрытия общего project fixture/удаления HOME.
 */
export async function startTestSupervisor(
  binary: string,
  options: RuntimeOptions,
  env: Readonly<Record<string, string | undefined>> = {},
): Promise<TestSupervisor> {
  if (!options.home) {
    throw new Error("Supervisor fixture требует явный isolated home");
  }
  const cancellation = new AbortController();
  let finished = false;
  let failure: unknown;
  const completion = runGuardedCommand({
    component: [binary],
    argv: [binary, "supervise", "--home", options.home, "--parent-lease"],
    cwd: options.cwd,
    env: { ...process.env, ...env },
    stdinLease: true,
    timeoutMs: null,
    maxOutputBytes: 128 * 1024,
    terminationGraceMs: 10_000,
    signal: cancellation.signal,
  })
    .then(
      (result) => {
        if (result.code !== 0) {
          failure = new Error(`Supervisor fixture exit ${result.code}: ${result.stderr}`);
        }
      },
      (error: unknown) => {
        failure = error;
      },
    )
    .finally(() => {
      finished = true;
    });
  const deadline = Date.now() + 15_000;
  try {
    while (!finished && Date.now() < deadline) {
      const endpoint = readEndpoint(join(options.home, "git-sync", "supervisor.json"));
      if (endpoint && (await responsive(endpoint))) {
        let stopped = false;
        return {
          endpoint,
          /**
           * Ждёт S и его owned workers; результат не основывается только на исчезнувшем PID/endpoint.
           */
          async stop(): Promise<void> {
            if (stopped) {
              return;
            }
            stopped = true;
            await controlRequest(endpoint, "shutdown");
            const timer = setTimeout(() => cancellation.abort(), 20_000);
            try {
              await completion;
            } finally {
              clearTimeout(timer);
            }
            if (
              failure &&
              !(
                cancellation.signal.aborted &&
                failure instanceof GuardedCommandError &&
                failure.reason === "cancelled"
              )
            ) {
              throw failure;
            }
          },
        };
      }
      await waitUntil(Date.now() + 50, cancellation.signal);
    }
    throw failure ?? new Error("Supervisor fixture не подтвердил readiness");
  } catch (error) {
    cancellation.abort();
    await completion;
    throw error;
  }
}
